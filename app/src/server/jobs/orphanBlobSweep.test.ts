import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(), list: vi.fn(), head: vi.fn() }));

import { inngestFunctions } from "./inngest-functions";
import { ORPHAN_MIN_AGE_MS, orphanBlobSweep, sweepOrphanBlobs } from "./orphanBlobSweep";

const HOST = "https://store1.public.blob.vercel-storage.com";
const NOW = Date.UTC(2026, 10, 15, 6, 25, 0);
const OLD = new Date(NOW - ORPHAN_MIN_AGE_MS - 60_000);
const YOUNG = new Date(NOW - ORPHAN_MIN_AGE_MS + 60_000);

type Blob = { url: string; pathname: string; uploadedAt: Date };

function blob(pathname: string, uploadedAt: Date = OLD): Blob {
  return { url: `${HOST}/${pathname}`, pathname, uploadedAt };
}

const LINK_FILE = "ul/link-1/0123456789abcdef-IMG_1.jpg";
const SIGNED_IN_FILE = "1731600000000-ab12cd34-cat.png";

/** The tables the sweep reads, as plain lists of stored addresses. */
function fakeDb(tables: { media?: string[]; covers?: string[]; logos?: string[] } = {}) {
  const media = tables.media ?? [];
  const covers = tables.covers ?? [];
  const logos = tables.logos ?? [];
  const inList = (values: string[], where: { in?: string[] }) => values.filter((v) => where.in?.includes(v));
  const containing = (values: string[], where: { contains?: string }) =>
    values.filter((v) => where.contains !== undefined && v.includes(where.contains)).length;
  const tables_ = {
    mediaItem: {
      findMany: vi.fn(async ({ where }: { where: { storageLocation: { in: string[] } } }) =>
        inList(media, where.storageLocation).map((storageLocation) => ({ storageLocation })),
      ),
      count: vi.fn(async ({ where }: { where: { storageLocation: { contains: string } } }) =>
        containing(media, where.storageLocation),
      ),
    },
    postJob: {
      findMany: vi.fn(async ({ where }: { where: { coverImageUrl: { in: string[] } } }) =>
        inList(covers, where.coverImageUrl).map((coverImageUrl) => ({ coverImageUrl })),
      ),
      count: vi.fn(async ({ where }: { where: { coverImageUrl: { contains: string } } }) =>
        containing(covers, where.coverImageUrl),
      ),
    },
    workspace: {
      findMany: vi.fn(async ({ where }: { where: { logoUrl: { in: string[] } } }) =>
        inList(logos, where.logoUrl).map((logoUrl) => ({ logoUrl })),
      ),
      count: vi.fn(async ({ where }: { where: { logoUrl: { contains: string } } }) => containing(logos, where.logoUrl)),
    },
    $executeRaw: vi.fn(async () => 1),
  };
  return {
    ...tables_,
    $transaction: vi.fn(async (fn: (tx: typeof tables_) => Promise<unknown>) => fn(tables_)),
  };
}

/** A store listing: `ul/` (expanded) and the root (folded), each in pages of the given blobs. */
function fakeList(sources: { ul?: Blob[][]; root?: Blob[][] }) {
  return vi.fn(async (options: { prefix?: string; mode?: string; cursor?: string }) => {
    const pages = options.prefix === "ul/" ? (sources.ul ?? [[]]) : (sources.root ?? [[]]);
    const index = options.cursor ? Number(options.cursor) : 0;
    const hasMore = index + 1 < pages.length;
    return { blobs: pages[index] ?? [], hasMore, cursor: hasMore ? String(index + 1) : undefined, folders: [] };
  });
}

function run(deps: { list: ReturnType<typeof fakeList>; db: ReturnType<typeof fakeDb>; del?: ReturnType<typeof vi.fn>; now?: () => number; budgetMs?: number }) {
  const del = deps.del ?? vi.fn(async () => undefined);
  return {
    del,
    result: sweepOrphanBlobs({
      list: deps.list as never,
      del: del as never,
      db: deps.db as never,
      now: deps.now ?? (() => NOW),
      budgetMs: deps.budgetMs,
    }),
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sweepOrphanBlobs", () => {
  it("lists the client link folder and the signed-in uploads at the root (folded, so folders are skipped)", async () => {
    const list = fakeList({});
    await run({ list, db: fakeDb() }).result;
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ul/", mode: "expanded" }));
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
    expect(db.mediaItem.findMany.mock.calls[0][0].where).not.toHaveProperty("deletedAt");
    expect(db.mediaItem.count.mock.calls[0][0].where).not.toHaveProperty("deletedAt");
  });

  it("never touches a file outside the upload shapes (covers, logos, anything else at the root)", async () => {
    const list = fakeList({
      ul: [[blob("ul/link-1/not-ours.jpg")]],
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
