import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(), list: vi.fn(), head: vi.fn() }));

import { logger } from "@/lib/logger";

import { inngestFunctions } from "./inngest-functions";
import {
  LINK_UPLOAD_MIN_AGE_MS,
  SIGNED_IN_UPLOAD_MIN_AGE_MS,
  orphanBlobSweep,
  sweepOrphanBlobs,
} from "./orphanBlobSweep";

const HOST = "https://store1.public.blob.vercel-storage.com";
const NOW = Date.UTC(2026, 10, 15, 6, 25, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Old enough for either place. */
const OLD = new Date(NOW - 8 * DAY);
const YOUNG = new Date(NOW - 23 * HOUR);

type Blob = { url: string; pathname: string; uploadedAt: Date };

function blob(pathname: string, uploadedAt: Date = OLD): Blob {
  return { url: `${HOST}/${pathname}`, pathname, uploadedAt };
}

const LINK_FILE = "ul/link-1/0123456789abcdef-IMG_1.jpg";
const SIGNED_IN_FILE = "1731600000000-ab12cd34-cat.png";

type Where = { in?: string[]; contains?: string } | string;
type Clause = Record<string, Where> & { OR?: Array<Record<string, Where>> };

/** Rows whose `column` matches `where`: an exact address, `in` a list, or `OR` of `contains`. */
function matching(values: string[], column: string, where: Clause): string[] {
  const one = (v: string, w: Where | undefined): boolean =>
    typeof w === "string" ? v === w : w?.in ? w.in.includes(v) : w?.contains !== undefined ? v.includes(w.contains) : false;
  if (where.OR) return values.filter((v) => where.OR!.some((clause) => one(v, clause[column])));
  return values.filter((v) => one(v, where[column]));
}

/**
 * The tables the sweep reads, as plain lists of stored addresses. `onLock` runs
 * when the sweep takes a file's lock: a registration that waited on it commits then.
 */
function fakeDb(
  tables: { media?: string[]; covers?: string[]; logos?: string[] } = {},
  onLock?: (stored: { media: string[]; covers: string[]; logos: string[] }) => void,
) {
  const stored = { media: [...(tables.media ?? [])], covers: [...(tables.covers ?? [])], logos: [...(tables.logos ?? [])] };
  const table = (values: string[], column: string) => ({
    findMany: vi.fn(async ({ where }: { where: Clause }) =>
      matching(values, column, where).map((value) => ({ [column]: value })),
    ),
    count: vi.fn(async ({ where }: { where: Clause }) => matching(values, column, where).length),
  });
  const tables_ = {
    mediaItem: table(stored.media, "storageLocation"),
    postJob: table(stored.covers, "coverImageUrl"),
    workspace: table(stored.logos, "logoUrl"),
    $executeRaw: vi.fn(async () => {
      onLock?.(stored);
      return 1;
    }),
  };
  return {
    ...tables_,
    $transaction: vi.fn(async (fn: (tx: typeof tables_) => Promise<unknown>) => fn(tables_)),
  };
}

/** A store listing: `ul/` and `covers/` (expanded) and the root (folded), each in pages of the given blobs. */
function fakeList(sources: { ul?: Blob[][]; covers?: Blob[][]; root?: Blob[][] }) {
  return vi.fn(async (options: { prefix?: string; mode?: string; cursor?: string }) => {
    const pages =
      options.prefix === "ul/"
        ? (sources.ul ?? [[]])
        : options.prefix === "covers/"
          ? (sources.covers ?? [[]])
          : (sources.root ?? [[]]);
    const index = options.cursor ? Number(options.cursor) : 0;
    const hasMore = index + 1 < pages.length;
    return { blobs: pages[index] ?? [], hasMore, cursor: hasMore ? String(index + 1) : undefined, folders: [] };
  });
}

function run(deps: {
  list: ReturnType<typeof fakeList> | ReturnType<typeof vi.fn>;
  db: ReturnType<typeof fakeDb>;
  del?: ReturnType<typeof vi.fn>;
  now?: () => number;
  budgetMs?: number;
  listTimeoutMs?: number;
}) {
  const del = deps.del ?? vi.fn(async () => undefined);
  return {
    del,
    result: sweepOrphanBlobs({
      list: deps.list as never,
      del: del as never,
      db: deps.db as never,
      now: deps.now ?? (() => NOW),
      budgetMs: deps.budgetMs,
      listTimeoutMs: deps.listTimeoutMs,
    }),
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sweepOrphanBlobs", () => {
  it("lists the client link folder, the covers folder and the signed-in uploads at the root (folded, so folders are skipped)", async () => {
    const list = fakeList({});
    await run({ list, db: fakeDb() }).result;
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ul/", mode: "expanded" }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "covers/", mode: "expanded" }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ mode: "folded" }));
    expect(list.mock.calls.find(([o]) => o.mode === "folded")?.[0].prefix).toBeUndefined();
  });

  it("deletes an unreferenced upload older than 24 hours, from both places", async () => {
    const list = fakeList({ ul: [[blob(LINK_FILE)]], root: [[blob(SIGNED_IN_FILE)]] });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 2, kept: 0, failed: 0, finished: true });
    expect(del).toHaveBeenCalledWith(`${HOST}/${LINK_FILE}`, expect.anything());
    expect(del).toHaveBeenCalledWith(`${HOST}/${SIGNED_IN_FILE}`, expect.anything());
  });

  it("waits 24 hours for a client link file but 7 days for a signed-in upload, which a draft may still be about to post", async () => {
    expect(LINK_UPLOAD_MIN_AGE_MS).toBe(DAY);
    expect(SIGNED_IN_UPLOAD_MIN_AGE_MS).toBe(7 * DAY);
    const list = fakeList({
      ul: [[blob(LINK_FILE, new Date(NOW - 25 * HOUR))]],
      root: [[blob("1731600000000-aa-two-days.jpg", new Date(NOW - 2 * DAY)), blob("1731600000000-bb-eight-days.jpg", new Date(NOW - 8 * DAY))]],
    });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 2 });
    expect(del).toHaveBeenCalledWith(`${HOST}/${LINK_FILE}`, expect.anything());
    expect(del).toHaveBeenCalledWith(`${HOST}/1731600000000-bb-eight-days.jpg`, expect.anything());
    expect(del).not.toHaveBeenCalledWith(`${HOST}/1731600000000-aa-two-days.jpg`, expect.anything());
  });

  it("ends the run cleanly when a listing call hangs", async () => {
    const list = vi.fn(
      (options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { del, result } = run({ list, db: fakeDb(), listTimeoutMs: 10 });

    await expect(result).resolves.toMatchObject({ deleted: 0, finished: false });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps an unreferenced upload younger than 24 hours", async () => {
    const list = fakeList({ ul: [[blob(LINK_FILE, YOUNG)]], root: [[blob(SIGNED_IN_FILE, YOUNG)]] });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps a file a MediaItem, a cover or a logo refers to", async () => {
    const files = ["1731600000000-aa-a.jpg", "1731600000000-bb-b.jpg", "1731600000000-cc-c.png"];
    const list = fakeList({ root: [files.map((f) => blob(f))] });
    const db = fakeDb({ media: [`${HOST}/${files[0]}`], covers: [`${HOST}/${files[1]}`], logos: [`${HOST}/${files[2]}`] });
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 3 });
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps a file referenced under another spelling of its address, and one in a deleted media row", async () => {
    const list = fakeList({ root: [[blob("1731600000000-aa-a.jpg"), blob("1731600000000-bb-b.jpg")]] });
    const db = fakeDb({
      media: [`  ${HOST.toUpperCase()}/1731600000000-aa-a.jpg `, `${HOST}/1731600000000-bb-b.jpg`],
    });
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 2 });
    expect(del).not.toHaveBeenCalled();
    // A soft-deleted row still counts: the retention sweep owns that file.
    for (const [{ where }] of db.mediaItem.findMany.mock.calls) expect(where).not.toHaveProperty("deletedAt");
  });

  it("never touches a file outside the upload shapes (logos, anything else at the root or in covers/)", async () => {
    const list = fakeList({
      ul: [[blob("ul/link-1/not-ours.jpg")]],
      covers: [[blob("covers/ws-1/sub/x.jpg"), blob("covers/x.jpg"), blob("covers/ws-1/.hidden")]],
      root: [[blob("covers/ws-1/x.jpg"), blob("logos/ws-1/x.png"), blob("hand-placed.png")]],
    });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it("pages through the listing", async () => {
    const list = fakeList({
      ul: [[blob("ul/link-1/0123456789abcdef-a.jpg")], [blob("ul/link-1/0123456789abcdef-b.jpg")]],
    });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 2, finished: true });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ul/", cursor: "1" }));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("carries on after a failed delete", async () => {
    const list = fakeList({
      ul: [[blob("ul/link-1/0123456789abcdef-a.jpg"), blob("ul/link-1/0123456789abcdef-b.jpg")]],
    });
    const del = vi.fn().mockRejectedValueOnce(new Error("store down")).mockResolvedValue(undefined);
    const { result } = run({ list, db: fakeDb(), del });

    await expect(result).resolves.toMatchObject({ deleted: 1, failed: 1, finished: true });
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly when its time is up", async () => {
    const list = fakeList({
      ul: [[blob("ul/link-1/0123456789abcdef-a.jpg")], [blob("ul/link-1/0123456789abcdef-b.jpg")]],
    });
    let clock = NOW;
    const del = vi.fn(async () => {
      clock += 10_000;
    });
    const { result } = run({ list, db: fakeDb(), del, now: () => clock, budgetMs: 5_000 });

    await expect(result).resolves.toMatchObject({ deleted: 1, finished: false });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("checks references in one query per table for each page, not one per file", async () => {
    const files = Array.from({ length: 50 }, (_, i) => blob(`1731600000000-ab-${i}.jpg`));
    const db = fakeDb({ media: files.map((f) => f.url) });
    const { result } = run({ list: fakeList({ root: [files] }), db });

    await expect(result).resolves.toMatchObject({ kept: 50 });
    expect(db.mediaItem.findMany).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// R2 M1: a cover uploaded on Create or Add many and never posted.
describe("sweepOrphanBlobs — video covers", () => {
  const COVER = "covers/ws-1/1731600000000-ab12cd34-cover.jpg";

  it("deletes a cover older than 7 days that no post refers to", async () => {
    const list = fakeList({ covers: [[blob(COVER, new Date(NOW - 8 * DAY))]] });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 1, failed: 0 });
    expect(del).toHaveBeenCalledWith(`${HOST}/${COVER}`, expect.anything());
  });

  it("keeps a cover younger than 7 days: it may still be on an open Create page", async () => {
    const list = fakeList({ covers: [[blob(COVER, new Date(NOW - 6 * DAY))]] });
    const { del, result } = run({ list, db: fakeDb() });

    await expect(result).resolves.toMatchObject({ deleted: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps a cover a post refers to, by its address or another spelling of it", async () => {
    const other = "covers/ws-2/1731600000000-cd-cover.jpg";
    const list = fakeList({ covers: [[blob(COVER), blob(other)]] });
    const db = fakeDb({ covers: [`${HOST}/${COVER}`, ` ${HOST.toUpperCase()}/${other}`] });
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 2 });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("sweepOrphanBlobs — a file referenced while the sweep runs", () => {
  it("keeps a file a registration wrote while the sweep waited for its lock", async () => {
    const list = fakeList({ ul: [[blob(LINK_FILE)]] });
    const db = fakeDb({}, (stored) => stored.media.push(`${HOST}/${LINK_FILE}`));
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 1 });
    expect(del).not.toHaveBeenCalled();
  });

  it("also under the store's other host for the same file", async () => {
    const path = "covers/ws-1/1731600000000-ab-cover.jpg";
    const list = fakeList({ covers: [[blob(path)]] });
    const privateHost = HOST.replace(".public.", ".private.");
    const db = fakeDb({}, (stored) => stored.covers.push(`${privateHost}/${path}`));
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 1 });
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps a cover a post took while the sweep waited for its lock", async () => {
    const path = "covers/ws-1/1731600000000-ab-cover.jpg";
    const list = fakeList({ covers: [[blob(path)]] });
    const db = fakeDb({}, (stored) => stored.covers.push(`${HOST}/${path}`));
    const { del, result } = run({ list, db });

    await expect(result).resolves.toMatchObject({ deleted: 0, kept: 1 });
    expect(del).not.toHaveBeenCalled();
  });
});

// Unconfirmed R2 cost: the check under the lock matches exact addresses (indexed
// columns); other spellings are looked for once per page, not once per file.
describe("sweepOrphanBlobs — cheap reference checks", () => {
  it("matches exactly under each file's lock and looks for other spellings once per table per page", async () => {
    const files = Array.from({ length: 50 }, (_, i) => blob(`1731600000000-ab-${i}.jpg`));
    const db = fakeDb();
    const { result } = run({ list: fakeList({ root: [files] }), db });

    await expect(result).resolves.toMatchObject({ deleted: 50 });
    for (const t of [db.mediaItem, db.postJob, db.workspace]) {
      expect(t.findMany).toHaveBeenCalledTimes(2);
      expect(t.count).toHaveBeenCalledTimes(50);
      for (const [{ where }] of t.count.mock.calls) {
        expect(JSON.stringify(where)).not.toContain("contains");
      }
    }
  });

  it("skips the spelling search when every file matched exactly", async () => {
    const files = [blob("1731600000000-ab-a.jpg")];
    const db = fakeDb({ media: [files[0].url] });
    const { result } = run({ list: fakeList({ root: [files] }), db });

    await expect(result).resolves.toMatchObject({ kept: 1 });
    expect(db.mediaItem.findMany).toHaveBeenCalledTimes(1);
  });
});

// R2 M1: a large ul/ must not keep the root and covers/ from ever being swept.
describe("sweepOrphanBlobs — every place gets its turn", () => {
  it("starts from a different place each day, so over three days each one is listed first", async () => {
    const firsts = new Set<string>();
    for (let day = 0; day < 3; day += 1) {
      const list = fakeList({});
      await run({ list, db: fakeDb(), now: () => NOW + day * DAY }).result;
      firsts.add(String(list.mock.calls[0][0].prefix));
    }
    expect(firsts).toEqual(new Set(["ul/", "covers/", "undefined"]));
  });

  it("still lists every place in one run when there is time", async () => {
    const list = fakeList({});
    await expect(run({ list, db: fakeDb() }).result).resolves.toMatchObject({ finished: true });
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe("orphanBlobSweep (orphan-blob-sweep)", () => {
  it("is registered and runs once a day", () => {
    expect(inngestFunctions).toContain(orphanBlobSweep);
    const { getConfig } = orphanBlobSweep as unknown as {
      getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
    };
    const triggers = getConfig
      .call(orphanBlobSweep, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
      .find((config) => config.id === "vibe-socials-orphan-blob-sweep")?.triggers;
    expect(triggers).toEqual([{ cron: "25 6 * * *" }]);
  });
});

// R69 security-billing L1: a failed delete is logged at warn (which reaches
// Sentry), so it names the file only through blobLogRef, never its name.
describe("a failed delete's log", () => {
  it("has no file name, only the store and the key's random part", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const list = fakeList({ ul: [[blob("ul/link-1/0123456789abcdef-Smith_family_beach.mp4")]] });
    const del = vi.fn().mockRejectedValue(new Error("store down"));

    await expect(run({ list, db: fakeDb(), del }).result).resolves.toMatchObject({ failed: 1 });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toMatch(/Smith|family|beach/);
    expect(logged).toContain("store1.public.blob.vercel-storage.com/ul/link-1/0123456789abcdef");
  });
});
