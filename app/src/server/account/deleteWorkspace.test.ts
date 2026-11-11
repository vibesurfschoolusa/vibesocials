import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory MediaItem table behind the two findMany shapes the queueing
// uses (a page of the workspaces' live media, and the surviving-workspace
// reference lookup), so the tests check behaviour, not call shapes.
const m = vi.hoisted(() => ({
  del: vi.fn(),
  rows: [] as { id: string; workspaceId: string; storageLocation: string; deletedAt: Date | null }[],
  mediaFindMany: vi.fn(),
  workspaceFindMany: vi.fn(),
  postJobFindFirst: vi.fn(),
  memberCount: vi.fn(),
  workspaceDeleteMany: vi.fn(),
  queueCreate: vi.fn(),
  queueDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
  log: [] as string[],
}));

vi.mock("@vercel/blob", () => ({ del: m.del }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: m.postJobFindFirst },
    workspaceMember: { count: m.memberCount },
    pendingBlobDeletion: { deleteMany: m.queueDeleteMany },
  },
}));

import {
  AFTER_COMMIT_BUDGET_MS,
  BLOB_DELETE_BATCH_SIZE,
  LAST_WORKSPACE_MESSAGE,
  OTHER_OWNER_MESSAGE,
  POST_PUBLISHING_MESSAGE,
  deleteQueuedFiles,
  deleteWorkspaceRows,
  isPostPublishing,
  queueWorkspaceFiles,
  workspaceDeletionRefusal,
} from "./deleteWorkspace";

type Where = {
  workspaceId?: { in?: string[]; notIn?: string[] };
  deletedAt?: null;
  id?: { gt: string };
  storageLocation?: { in: string[] };
};

function fakeFindMany({ where, take }: { where: Where; take?: number }) {
  let result = m.rows.filter((row) => {
    if (where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.workspaceId?.in && !where.workspaceId.in.includes(row.workspaceId)) return false;
    if (where.workspaceId?.notIn && where.workspaceId.notIn.includes(row.workspaceId)) return false;
    if (where.id && !(row.id > where.id.gt)) return false;
    if (where.storageLocation && !where.storageLocation.in.includes(row.storageLocation)) return false;
    return true;
  });
  result = [...result].sort((a, b) => (a.id < b.id ? -1 : 1));
  return Promise.resolve(take ? result.slice(0, take) : result);
}

const tx = {
  $executeRaw: m.executeRaw,
  mediaItem: { findMany: m.mediaFindMany },
  workspace: { findMany: m.workspaceFindMany },
  pendingBlobDeletion: { createManyAndReturn: m.queueCreate },
} as unknown as Prisma.TransactionClient;

const url = (name: string) => `https://abc123.public.blob.vercel-storage.com/${name}.png`;
/** The urls queued by the last createManyAndReturn call. */
const queuedUrls = () =>
  (m.queueCreate.mock.calls.at(-1)?.[0].data as { url: string }[] | undefined)?.map((row) => row.url) ?? [];

beforeEach(() => {
  m.rows.length = 0;
  for (const mock of Object.values(m)) {
    if (typeof mock === "function") mock.mockReset();
  }
  m.del.mockResolvedValue(undefined);
  m.log.length = 0;
  m.executeRaw.mockResolvedValue(0);
  m.mediaFindMany.mockImplementation(fakeFindMany);
  m.workspaceFindMany.mockResolvedValue([]);
  m.queueCreate.mockImplementation(async ({ data }: { data: { url: string }[] }) =>
    data.map((row, index) => ({ id: `q${index}`, url: row.url })),
  );
  m.queueDeleteMany.mockResolvedValue({ count: 0 });
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queueWorkspaceFiles", () => {
  it("queues the files of the workspace's live media and returns the queue rows", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("a"), deletedAt: null },
      { id: "m2", workspaceId: "ws-1", storageLocation: url("b"), deletedAt: null },
      { id: "m3", workspaceId: "ws-1", storageLocation: url("gone"), deletedAt: new Date() },
      { id: "m4", workspaceId: "ws-other", storageLocation: url("theirs"), deletedAt: null },
    );

    const queued = await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(m.queueCreate).toHaveBeenCalledWith({
      data: [{ url: url("a") }, { url: url("b") }],
      select: { id: true, url: true },
    });
    expect(queued).toEqual([
      { id: "q0", url: url("a") },
      { id: "q1", url: url("b") },
    ]);
    expect(m.del).not.toHaveBeenCalled();
  });

  it("does not queue a file a live item in a surviving workspace still uses", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("shared"), deletedAt: null },
      { id: "m2", workspaceId: "ws-1", storageLocation: url("mine"), deletedAt: null },
      { id: "m3", workspaceId: "ws-other", storageLocation: url("shared"), deletedAt: null },
    );

    await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(queuedUrls()).toEqual([url("mine")]);
  });

  it("matches a surviving workspace's row by the canonical spelling too", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: `${url("shared")}?download=1`, deletedAt: null },
      { id: "m2", workspaceId: "ws-other", storageLocation: url("shared"), deletedAt: null },
    );

    await expect(queueWorkspaceFiles(tx, ["ws-1"])).resolves.toEqual([]);

    expect(m.queueCreate).not.toHaveBeenCalled();
  });

  it("ignores a soft-deleted row in another workspace", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("a"), deletedAt: null },
      { id: "m2", workspaceId: "ws-other", storageLocation: url("a"), deletedAt: new Date() },
    );

    await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(queuedUrls()).toEqual([url("a")]);
  });

  it("queues a file shared only between workspaces that are all being deleted, once", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("both"), deletedAt: null },
      { id: "m2", workspaceId: "ws-2", storageLocation: url("both"), deletedAt: null },
    );

    await queueWorkspaceFiles(tx, ["ws-1", "ws-2"]);

    expect(queuedUrls()).toEqual([url("both")]);
  });

  it("pages through a large workspace and queues every file once", async () => {
    const total = BLOB_DELETE_BATCH_SIZE * 2 + 5;
    for (let index = 0; index < total; index += 1) {
      const id = `m${String(index).padStart(4, "0")}`;
      m.rows.push({ id, workspaceId: "ws-1", storageLocation: url(id), deletedAt: null });
    }

    await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(new Set(queuedUrls()).size).toBe(total);
    expect(queuedUrls()).toHaveLength(total);
  });

  it("locks every candidate file key, sorted, before asking whether a surviving workspace uses it", async () => {
    m.rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("zeta"), deletedAt: null },
      { id: "m2", workspaceId: "ws-1", storageLocation: url("alpha"), deletedAt: null },
      { id: "m3", workspaceId: "ws-1", storageLocation: `${url("mid")}?x=1`, deletedAt: null },
    );
    // Tagged template: (strings, ...values), so the lock key is the first value.
    m.executeRaw.mockImplementation(async (strings: TemplateStringsArray, key: string) => {
      m.log.push(`lock ${strings.join("?")} ${key}`);
      return 0;
    });
    m.mediaFindMany.mockImplementation(async (args: { where: Where; take?: number }) => {
      m.log.push(args.where.storageLocation ? "check elsewhere" : "page");
      return fakeFindMany(args);
    });

    await queueWorkspaceFiles(tx, ["ws-1"]);

    // The same lock deleteBlobUnlessShared takes (mediaBlob.ts), keyed by guardBlobKey.
    const lock = (key: string) => `lock SELECT pg_advisory_xact_lock(hashtext(?)) ${key}`;
    expect(m.log).toEqual([
      "page",
      lock(url("alpha")),
      lock(url("mid")),
      lock(url("zeta")),
      "check elsewhere",
    ]);
  });

  it("queues the workspaces' logos with their media files", async () => {
    m.rows.push({ id: "m1", workspaceId: "ws-1", storageLocation: url("a"), deletedAt: null });
    m.workspaceFindMany.mockResolvedValue([{ logoUrl: url("logos/ws-1/0123456789abcdef") }]);

    await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(m.workspaceFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["ws-1"] }, logoUrl: { not: null } },
      select: { logoUrl: true },
    });
    expect(queuedUrls().sort()).toEqual([url("a"), url("logos/ws-1/0123456789abcdef")]);
  });

  it("queues a logo of a workspace with no media", async () => {
    m.workspaceFindMany.mockResolvedValue([{ logoUrl: url("logos/ws-1/0123456789abcdef") }]);

    const queued = await queueWorkspaceFiles(tx, ["ws-1"]);

    expect(queued).toEqual([{ id: "q0", url: url("logos/ws-1/0123456789abcdef") }]);
  });

  it("queues nothing for a workspace with no media", async () => {
    await expect(queueWorkspaceFiles(tx, ["ws-1"])).resolves.toEqual([]);
    expect(m.queueCreate).not.toHaveBeenCalled();
  });
});

describe("deleteQueuedFiles", () => {
  const queue = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `q${index}`, url: url(`f${index}`) }));

  it("deletes the files in batches and removes their queue rows", async () => {
    const rows = queue(BLOB_DELETE_BATCH_SIZE + 3);

    await expect(deleteQueuedFiles(rows)).resolves.toEqual({ deleted: rows.length, left: 0 });

    expect(m.del).toHaveBeenCalledTimes(2);
    expect(m.del.mock.calls[0][0]).toHaveLength(BLOB_DELETE_BATCH_SIZE);
    expect(m.del).toHaveBeenCalledWith(
      rows.slice(BLOB_DELETE_BATCH_SIZE).map((row) => row.url),
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(m.queueDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: rows.slice(BLOB_DELETE_BATCH_SIZE).map((row) => row.id) } },
    });
  });

  it("leaves a failed batch queued, goes on with the next, and never throws", async () => {
    const rows = queue(BLOB_DELETE_BATCH_SIZE + 1);
    m.del.mockRejectedValueOnce(new Error("blob down"));

    await expect(deleteQueuedFiles(rows)).resolves.toEqual({ deleted: 1, left: BLOB_DELETE_BATCH_SIZE });

    expect(m.queueDeleteMany).toHaveBeenCalledTimes(1);
    expect(m.queueDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["q100"] } } });
  });

  it("stops at 20 seconds and leaves the rest queued", async () => {
    const rows = queue(BLOB_DELETE_BATCH_SIZE * 3);
    let clock = 0;
    m.del.mockImplementation(async () => {
      clock += 12_000;
    });

    const result = await deleteQueuedFiles(rows, { now: () => clock });

    expect(AFTER_COMMIT_BUDGET_MS).toBe(20_000);
    expect(result).toEqual({ deleted: BLOB_DELETE_BATCH_SIZE * 2, left: BLOB_DELETE_BATCH_SIZE });
    expect(m.del).toHaveBeenCalledTimes(2);
  });

  it("still reports success when removing the queue rows fails (the drain retries them)", async () => {
    m.queueDeleteMany.mockRejectedValue(new Error("db down"));

    await expect(deleteQueuedFiles(queue(2))).resolves.toEqual({ deleted: 0, left: 2 });
  });

  it("does nothing for an empty queue", async () => {
    await expect(deleteQueuedFiles([])).resolves.toEqual({ deleted: 0, left: 0 });
    expect(m.del).not.toHaveBeenCalled();
  });
});

describe("isPostPublishing", () => {
  it("looks for a pending or in-progress job in the given workspaces", async () => {
    m.postJobFindFirst.mockResolvedValue({ id: "job-1" });

    await expect(isPostPublishing(["ws-1"])).resolves.toBe(true);

    expect(m.postJobFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: { in: ["ws-1"] }, status: { in: ["pending", "in_progress"] } },
      select: { id: true },
    });
  });

  it("uses the client it is given", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);

    await expect(isPostPublishing(["ws-1"], { postJob: { findFirst } } as never)).resolves.toBe(false);

    expect(findFirst).toHaveBeenCalled();
    expect(m.postJobFindFirst).not.toHaveBeenCalled();
  });

  it("is false without a database call when there are no workspaces", async () => {
    await expect(isPostPublishing([])).resolves.toBe(false);

    expect(m.postJobFindFirst).not.toHaveBeenCalled();
  });
});

describe("workspaceDeletionRefusal", () => {
  function setup({ otherOwners = 0, publishing = false, memberships = 2 }) {
    m.memberCount.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "owner" ? otherOwners : memberships,
    );
    m.postJobFindFirst.mockResolvedValue(publishing ? { id: "job-1" } : null);
  }

  it("refuses when another owner exists", async () => {
    setup({ otherOwners: 1 });

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBe(OTHER_OWNER_MESSAGE);
    expect(m.memberCount).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner", userId: { not: "u-1" } },
    });
  });

  it("refuses while a post is publishing", async () => {
    setup({ publishing: true });

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBe(POST_PUBLISHING_MESSAGE);
  });

  it("refuses the user's last workspace", async () => {
    setup({ memberships: 1 });

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBe(LAST_WORKSPACE_MESSAGE);
    expect(m.memberCount).toHaveBeenCalledWith({ where: { userId: "u-1" } });
  });

  it("allows it otherwise", async () => {
    setup({});

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBeNull();
  });
});

describe("deleteWorkspaceRows", () => {
  it("deletes exactly the given workspace rows", async () => {
    m.workspaceDeleteMany.mockResolvedValue({ count: 2 });

    await deleteWorkspaceRows({ workspace: { deleteMany: m.workspaceDeleteMany } } as never, ["ws-1", "ws-2"]);

    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ws-1", "ws-2"] } } });
  });
});
