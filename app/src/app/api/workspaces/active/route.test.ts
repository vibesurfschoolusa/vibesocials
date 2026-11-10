import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/switch/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` (the shared `requireOwnerContext` owner gate — review
// fix round 1, Minor 1) at module scope, so both must be mocked before
// route.ts is imported below. The gate's own 401/403 mapping is unit-tested
// in src/lib/workspace.test.ts; here it's mocked to either the owner
// context or a ready-made error response.
//
// DELETE runs the real server/account/deleteWorkspace.ts against these
// mocks. `m.callLog` records the transaction's start and commit (or
// rollback) and every write, so the tests check that the queue rows and the
// row deletes share the transaction and that no file is deleted before the
// commit.
const m = vi.hoisted(() => ({
  update: vi.fn(),
  requireOwnerContext: vi.fn(),
  provisionPersonalWorkspace: vi.fn(),
  checkRateLimit: vi.fn(),
  cookieSet: vi.fn(),
  del: vi.fn(),
  memberCount: vi.fn(),
  memberFindMany: vi.fn(),
  postJobFindFirst: vi.fn(),
  mediaFindMany: vi.fn(),
  workspaceDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
  queueCreate: vi.fn(),
  queueDeleteMany: vi.fn(),
  callLog: [] as string[],
}));
const updateMock = m.update;
const requireOwnerContextMock = m.requireOwnerContext;

vi.mock("@/lib/db", () => {
  // $transaction replays the callback against this same object (mirrors
  // workspaces/leave/route.test.ts), so tx.<model> resolves to these mocks.
  const prisma: Record<string, unknown> = {
    $executeRaw: m.executeRaw,
    workspace: { update: m.update, deleteMany: m.workspaceDeleteMany },
    workspaceMember: { count: m.memberCount, findMany: m.memberFindMany },
    postJob: { findFirst: m.postJobFindFirst },
    mediaItem: { findMany: m.mediaFindMany },
    pendingBlobDeletion: { createManyAndReturn: m.queueCreate, deleteMany: m.queueDeleteMany },
    $transaction: async (cb: (tx: unknown) => unknown) => {
      m.callLog.push("transaction");
      try {
        const result = await cb(prisma);
        m.callLog.push("commit");
        return result;
      } catch (error) {
        m.callLog.push("rollback");
        throw error;
      }
    },
  };
  return { prisma };
});

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
  requireOwnerContext: m.requireOwnerContext,
  provisionPersonalWorkspace: m.provisionPersonalWorkspace,
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: m.cookieSet }) }));
vi.mock("@vercel/blob", () => ({ del: m.del }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DELETE, PATCH } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Old name", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 1,
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/workspaces/active", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updateMock.mockReset();
  requireOwnerContextMock.mockReset();
  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
});

describe("PATCH /api/workspaces/active", () => {
  it("returns the gate's 401 response as-is when unauthenticated", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await PATCH(jsonRequest({ name: "New name" }));

    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is when a member (not owner) calls it", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await PATCH(jsonRequest({ name: "New name" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = new Request("http://localhost/api/workspaces/active", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    const response = await PATCH(badRequest);

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing or not a string", async () => {
    const response = await PATCH(jsonRequest({}));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the trimmed name is empty", async () => {
    const response = await PATCH(jsonRequest({ name: "   " }));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the trimmed name exceeds 60 characters", async () => {
    const response = await PATCH(jsonRequest({ name: "a".repeat(61) }));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts a name at exactly 60 characters", async () => {
    const name = "a".repeat(60);
    updateMock.mockResolvedValue({ id: "ws-1", name });

    const response = await PATCH(jsonRequest({ name }));

    expect(response.status).toBe(200);
  });

  it("accepts a name at exactly 1 character", async () => {
    updateMock.mockResolvedValue({ id: "ws-1", name: "x" });

    const response = await PATCH(jsonRequest({ name: "x" }));

    expect(response.status).toBe(200);
  });

  it("trims the name before validating and persisting, and updates the ACTIVE workspace", async () => {
    updateMock.mockResolvedValue({ id: "ws-1", name: "Trimmed name" });

    const response = await PATCH(jsonRequest({ name: "  Trimmed name  " }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ id: "ws-1", name: "Trimmed name" });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { name: "Trimmed name" },
      select: { id: true, name: true },
    });
  });
});

describe("DELETE /api/workspaces/active", () => {
  const FILE = (name: string) => `https://abc123.public.blob.vercel-storage.com/${name}.png`;

  type MediaRow = { id: string; workspaceId: string; storageLocation: string };
  type MediaWhere = {
    workspaceId: { in?: string[]; notIn?: string[] };
    id?: { gt: string };
    storageLocation?: { in: string[] };
  };
  let media: MediaRow[];
  let otherMembers: { user: { id: string; name: string | null; email: string } }[];
  let remainingMemberships: Record<string, number>;

  function deleteRequest(body: unknown): Request {
    return new Request("http://localhost/api/workspaces/active", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Counts for workspaceDeletionRefusal, then the rehome counts. */
  function refusalCounts({ otherOwners = 0, callerMemberships = 2 } = {}) {
    m.memberCount.mockImplementation(
      async ({ where }: { where: { role?: string; userId: unknown } }) => {
        if (where.role === "owner") {
          m.callLog.push("check owners");
          return otherOwners;
        }
        if (where.userId === "user-1") {
          m.callLog.push("check memberships");
          return callerMemberships;
        }
        return remainingMemberships[where.userId as string] ?? 0;
      },
    );
  }

  function nothingWritten() {
    for (const mock of [m.queueCreate, m.workspaceDeleteMany, m.provisionPersonalWorkspace, m.del, m.cookieSet]) {
      expect(mock).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    m.callLog.length = 0;
    media = [];
    otherMembers = [];
    remainingMemberships = {};
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    for (const mock of [
      m.provisionPersonalWorkspace,
      m.checkRateLimit,
      m.cookieSet,
      m.del,
      m.memberCount,
      m.memberFindMany,
      m.postJobFindFirst,
      m.mediaFindMany,
      m.workspaceDeleteMany,
      m.executeRaw,
      m.queueCreate,
      m.queueDeleteMany,
    ]) {
      mock.mockReset();
    }
    m.checkRateLimit.mockResolvedValue({ allowed: true });
    refusalCounts();
    m.postJobFindFirst.mockResolvedValue(null);
    m.executeRaw.mockImplementation(async (_strings: unknown, key: string) => {
      m.callLog.push(`lock ${key}`);
      return 0;
    });
    m.del.mockImplementation(async (keys: string[]) => {
      m.callLog.push(`del ${keys.join(",")}`);
    });
    m.queueCreate.mockImplementation(async ({ data }: { data: { url: string }[] }) => {
      m.callLog.push(`queue ${data.map((row) => row.url).join(",")}`);
      return data.map((row, index) => ({ id: `q${index}`, url: row.url }));
    });
    m.queueDeleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      m.callLog.push(`unqueue ${where.id.in.join(",")}`);
      return { count: where.id.in.length };
    });
    m.workspaceDeleteMany.mockImplementation(async () => {
      m.callLog.push("delete-workspace");
      return { count: 1 };
    });
    m.memberFindMany.mockImplementation(async () => otherMembers);
    m.mediaFindMany.mockImplementation(async ({ where }: { where: MediaWhere }) =>
      media.filter((row) => {
        if (where.workspaceId.in && !where.workspaceId.in.includes(row.workspaceId)) return false;
        if (where.workspaceId.notIn && where.workspaceId.notIn.includes(row.workspaceId)) return false;
        if (where.id && !(row.id > where.id.gt)) return false;
        if (where.storageLocation && !where.storageLocation.in.includes(row.storageLocation)) {
          return false;
        }
        return true;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the gate's 403 as-is when a member calls it, and changes nothing", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(403);
    nothingWritten();
  });

  it("returns the gate's 401 when signed out", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(429);
    nothingWritten();
  });

  it("returns 400 on invalid JSON", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/workspaces/active", { method: "DELETE", body: "{nope" }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when confirmName does not match exactly", async () => {
    for (const confirmName of ["old name", "Old name ", "", undefined]) {
      const response = await DELETE(deleteRequest({ confirmName }));
      expect(response.status).toBe(400);
    }
    nothingWritten();
  });

  it("refuses with 409 when another owner exists, writing nothing and deleting no file", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    refusalCounts({ otherOwners: 1 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This workspace has another owner. Only a workspace with one owner can be deleted.",
    });
    expect(m.callLog.at(-1)).toBe("rollback");
    nothingWritten();
  });

  it("checks for a second owner under the ws-owners lock, inside the transaction", async () => {
    // A co-owner promoted after the Settings page loaded, before this request.
    refusalCounts({ otherOwners: 1 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    expect(m.callLog).toEqual(["transaction", "lock ws-owners:ws-1", "check owners", "rollback"]);
  });

  it("refuses with 409 while a post is publishing, writing nothing", async () => {
    m.postJobFindFirst.mockResolvedValue({ id: "job-1" });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A post is publishing right now. Try again in a few minutes.",
    });
    nothingWritten();
  });

  it("refuses with 409 when it is the caller's last workspace, writing nothing", async () => {
    refusalCounts({ callerMemberships: 1 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This is your only workspace. To leave Vibe Socials, delete your account instead.",
    });
    nothingWritten();
  });

  it("queues the files and deletes the rows in one transaction, then deletes the files after the commit", async () => {
    media = [
      { id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") },
      { id: "m2", workspaceId: "ws-1", storageLocation: FILE("b") },
    ];

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(m.callLog).toEqual([
      "transaction",
      "lock ws-owners:ws-1",
      "check owners",
      "check memberships",
      `queue ${FILE("a")},${FILE("b")}`,
      "delete-workspace",
      "commit",
      `del ${FILE("a")},${FILE("b")}`,
      "unqueue q0,q1",
    ]);
    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ws-1"] } } });
    expect(m.cookieSet).toHaveBeenCalledWith(
      "vs_active_workspace",
      "",
      expect.objectContaining({ maxAge: 0, path: "/" }),
    );
  });

  it("does not queue a file another workspace still uses", async () => {
    media = [
      { id: "m1", workspaceId: "ws-1", storageLocation: FILE("shared") },
      { id: "m2", workspaceId: "ws-1", storageLocation: FILE("mine") },
      { id: "m3", workspaceId: "ws-other", storageLocation: FILE("shared") },
    ];

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    expect(m.queueCreate).toHaveBeenCalledWith({
      data: [{ url: FILE("mine") }],
      select: { id: true, url: true },
    });
    expect(m.del).toHaveBeenCalledWith([FILE("mine")], expect.anything());
  });

  it("still succeeds when the files fail to delete after the commit, and leaves them queued", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    m.del.mockRejectedValue(new Error("blob down"));

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(m.workspaceDeleteMany).toHaveBeenCalled();
    expect(m.queueDeleteMany).not.toHaveBeenCalled();
    expect(m.cookieSet).toHaveBeenCalled();
  });

  it("answers 500 and deletes no file when the transaction fails", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    m.workspaceDeleteMany.mockRejectedValue(new Error("connection lost"));

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not delete this workspace. Nothing was changed. Try again.",
    });
    expect(m.callLog.at(-1)).toBe("rollback");
    expect(m.del).not.toHaveBeenCalled();
    expect(m.cookieSet).not.toHaveBeenCalled();
  });

  it("gives a member left with no workspace a new personal one, in the same transaction", async () => {
    otherMembers = [
      { user: { id: "user-2", name: "Lonely", email: "lonely@example.com" } },
      { user: { id: "user-3", name: "Busy", email: "busy@example.com" } },
    ];
    remainingMemberships = { "user-2": 0, "user-3": 1 };
    m.provisionPersonalWorkspace.mockImplementation(async () => {
      m.callLog.push("provision");
      return { workspaceId: "ws-new" };
    });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    expect(m.memberFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: { not: "user-1" } },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    expect(m.provisionPersonalWorkspace).toHaveBeenCalledTimes(1);
    expect(m.provisionPersonalWorkspace).toHaveBeenCalledWith(expect.anything(), {
      id: "user-2",
      name: "Lonely",
      email: "lonely@example.com",
    });
    expect(m.callLog.indexOf("delete-workspace")).toBeLessThan(m.callLog.indexOf("provision"));
    expect(m.callLog.indexOf("provision")).toBeLessThan(m.callLog.indexOf("commit"));
  });

  it("acts only on the caller's active owned workspace, whatever the body says", async () => {
    media = [
      { id: "m1", workspaceId: "ws-1", storageLocation: FILE("mine") },
      { id: "m2", workspaceId: "ws-victim", storageLocation: FILE("theirs") },
    ];

    const response = await DELETE(
      deleteRequest({ confirmName: "Old name", workspaceId: "ws-victim", id: "ws-victim" }),
    );

    expect(response.status).toBe(200);
    expect(m.workspaceDeleteMany).toHaveBeenCalledTimes(1);
    expect(m.workspaceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ws-1"] } } });
    expect(m.del).toHaveBeenCalledWith([FILE("mine")], expect.anything());
    expect(m.postJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: { in: ["ws-1"] } }),
      }),
    );
  });
});
