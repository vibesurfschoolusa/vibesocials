import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory MediaItem table behind the two findMany shapes the cleanup
// uses (a page of the workspace's live media, and the other-workspace
// reference lookup), so the tests check behaviour, not call shapes.
const { delMock, rows, findManyMock, findFirstMock, countMock, deleteManyMock } = vi.hoisted(() => ({
  delMock: vi.fn(),
  rows: [] as { id: string; workspaceId: string; storageLocation: string; deletedAt: Date | null }[],
  findManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  countMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del: delMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: { findMany: findManyMock },
    postJob: { findFirst: findFirstMock },
    workspaceMember: { count: countMock },
  },
}));

import {
  BLOB_DELETE_BATCH_SIZE,
  LAST_WORKSPACE_MESSAGE,
  OTHER_OWNER_MESSAGE,
  POST_PUBLISHING_MESSAGE,
  deleteWorkspaceFiles,
  deleteWorkspaceRows,
  isPostPublishing,
  workspaceDeletionRefusal,
} from "./deleteWorkspace";

type Where = {
  workspaceId?: { in?: string[]; notIn?: string[] };
  deletedAt?: null;
  id?: { gt: string };
  storageLocation?: { in: string[] };
};

function fakeFindMany({ where, take }: { where: Where; take?: number }) {
  let result = rows.filter((row) => {
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

const url = (name: string) => `https://abc123.public.blob.vercel-storage.com/${name}.png`;

beforeEach(() => {
  rows.length = 0;
  delMock.mockReset();
  delMock.mockResolvedValue(undefined);
  findManyMock.mockReset();
  findManyMock.mockImplementation(fakeFindMany);
  findFirstMock.mockReset();
  countMock.mockReset();
  deleteManyMock.mockReset();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deleteWorkspaceFiles", () => {
  it("deletes the stored files of the workspace's live media, with an abort signal", async () => {
    rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("a"), deletedAt: null },
      { id: "m2", workspaceId: "ws-1", storageLocation: url("b"), deletedAt: null },
      { id: "m3", workspaceId: "ws-1", storageLocation: url("gone"), deletedAt: new Date() },
      { id: "m4", workspaceId: "ws-other", storageLocation: url("theirs"), deletedAt: null },
    );

    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith([url("a"), url("b")], { abortSignal: expect.any(AbortSignal) });
  });

  it("keeps a file a live item in another workspace still uses", async () => {
    rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("shared"), deletedAt: null },
      { id: "m2", workspaceId: "ws-1", storageLocation: url("mine"), deletedAt: null },
      { id: "m3", workspaceId: "ws-other", storageLocation: url("shared"), deletedAt: null },
    );

    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).toHaveBeenCalledWith([url("mine")], expect.anything());
  });

  it("matches another workspace's row by the canonical spelling too", async () => {
    rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: `${url("shared")}?download=1`, deletedAt: null },
      { id: "m2", workspaceId: "ws-other", storageLocation: url("shared"), deletedAt: null },
    );

    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).not.toHaveBeenCalled();
  });

  it("ignores a soft-deleted row in another workspace", async () => {
    rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("a"), deletedAt: null },
      { id: "m2", workspaceId: "ws-other", storageLocation: url("a"), deletedAt: new Date() },
    );

    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).toHaveBeenCalledWith([url("a")], expect.anything());
  });

  it("deletes a file shared only between workspaces that are all being deleted", async () => {
    rows.push(
      { id: "m1", workspaceId: "ws-1", storageLocation: url("both"), deletedAt: null },
      { id: "m2", workspaceId: "ws-2", storageLocation: url("both"), deletedAt: null },
    );

    await deleteWorkspaceFiles(["ws-1", "ws-2"]);

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith([url("both")], expect.anything());
  });

  it("deletes in batches", async () => {
    const total = BLOB_DELETE_BATCH_SIZE * 2 + 5;
    for (let index = 0; index < total; index += 1) {
      const id = `m${String(index).padStart(4, "0")}`;
      rows.push({ id, workspaceId: "ws-1", storageLocation: url(id), deletedAt: null });
    }

    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).toHaveBeenCalledTimes(3);
    const deleted = delMock.mock.calls.flatMap((call) => call[0] as string[]);
    expect(deleted).toHaveLength(total);
    expect(new Set(deleted).size).toBe(total);
    expect((delMock.mock.calls[0][0] as string[]).length).toBe(BLOB_DELETE_BATCH_SIZE);
  });

  it("stops at the first failed batch and throws", async () => {
    for (let index = 0; index < BLOB_DELETE_BATCH_SIZE * 2; index += 1) {
      const id = `m${String(index).padStart(4, "0")}`;
      rows.push({ id, workspaceId: "ws-1", storageLocation: url(id), deletedAt: null });
    }
    delMock.mockRejectedValueOnce(new Error("blob down"));

    await expect(deleteWorkspaceFiles(["ws-1"])).rejects.toThrow("blob down");

    expect(delMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a workspace with no media", async () => {
    await deleteWorkspaceFiles(["ws-1"]);

    expect(delMock).not.toHaveBeenCalled();
  });
});

describe("isPostPublishing", () => {
  it("looks for a pending or in-progress job in the given workspaces", async () => {
    findFirstMock.mockResolvedValue({ id: "job-1" });

    await expect(isPostPublishing(["ws-1"])).resolves.toBe(true);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: { in: ["ws-1"] }, status: { in: ["pending", "in_progress"] } },
      select: { id: true },
    });
  });

  it("is false when none is publishing", async () => {
    findFirstMock.mockResolvedValue(null);

    await expect(isPostPublishing(["ws-1"])).resolves.toBe(false);
  });

  it("is false without a database call when there are no workspaces", async () => {
    await expect(isPostPublishing([])).resolves.toBe(false);

    expect(findFirstMock).not.toHaveBeenCalled();
  });
});

describe("workspaceDeletionRefusal", () => {
  function setup({ otherOwners = 0, publishing = false, memberships = 2 }) {
    countMock.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "owner" ? otherOwners : memberships,
    );
    findFirstMock.mockResolvedValue(publishing ? { id: "job-1" } : null);
  }

  it("refuses when another owner exists", async () => {
    setup({ otherOwners: 1 });

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBe(OTHER_OWNER_MESSAGE);
    expect(countMock).toHaveBeenCalledWith({
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
    expect(countMock).toHaveBeenCalledWith({ where: { userId: "u-1" } });
  });

  it("allows it otherwise", async () => {
    setup({});

    await expect(workspaceDeletionRefusal("ws-1", "u-1")).resolves.toBeNull();
  });
});

describe("deleteWorkspaceRows", () => {
  it("deletes exactly the given workspace rows", async () => {
    deleteManyMock.mockResolvedValue({ count: 2 });
    const tx = { workspace: { deleteMany: deleteManyMock } };

    await deleteWorkspaceRows(tx, ["ws-1", "ws-2"]);

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["ws-1", "ws-2"] } } });
  });
});
