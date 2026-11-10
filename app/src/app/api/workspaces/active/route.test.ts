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
// mocks, so its tests check the order of file and row deletion end to end.
const {
  updateMock,
  requireOwnerContextMock,
  provisionPersonalWorkspaceMock,
  checkRateLimitMock,
  cookieSetMock,
  delMock,
  memberCountMock,
  memberFindManyMock,
  postJobFindFirstMock,
  mediaFindManyMock,
  workspaceDeleteManyMock,
  executeRawMock,
  callLog,
} = vi.hoisted(() => ({
  updateMock: vi.fn(),
  requireOwnerContextMock: vi.fn(),
  provisionPersonalWorkspaceMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  cookieSetMock: vi.fn(),
  delMock: vi.fn(),
  memberCountMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  postJobFindFirstMock: vi.fn(),
  mediaFindManyMock: vi.fn(),
  workspaceDeleteManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  callLog: [] as string[],
}));

vi.mock("@/lib/db", () => {
  // $transaction replays the callback against this same object (mirrors
  // workspaces/leave/route.test.ts), so tx.<model> resolves to these mocks.
  const prisma: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    workspace: { update: updateMock, deleteMany: workspaceDeleteManyMock },
    workspaceMember: { count: memberCountMock, findMany: memberFindManyMock },
    postJob: { findFirst: postJobFindFirstMock },
    mediaItem: { findMany: mediaFindManyMock },
    $transaction: (cb: (tx: unknown) => unknown) => {
      callLog.push("transaction");
      return cb(prisma);
    },
  };
  return { prisma };
});

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
  requireOwnerContext: requireOwnerContextMock,
  provisionPersonalWorkspace: provisionPersonalWorkspaceMock,
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSetMock }) }));
vi.mock("@vercel/blob", () => ({ del: delMock }));

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

  /** Counts for workspaceDeletionRefusal, then the in-transaction rehome counts. */
  function refusalCounts({ otherOwners = 0, callerMemberships = 2 } = {}) {
    memberCountMock.mockImplementation(
      async ({ where }: { where: { role?: string; userId: unknown } }) => {
        if (where.role === "owner") return otherOwners;
        if (where.userId === "user-1") return callerMemberships;
        return remainingMemberships[where.userId as string] ?? 0;
      },
    );
  }

  beforeEach(() => {
    callLog.length = 0;
    media = [];
    otherMembers = [];
    remainingMemberships = {};
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    for (const mock of [
      provisionPersonalWorkspaceMock,
      checkRateLimitMock,
      cookieSetMock,
      delMock,
      memberCountMock,
      memberFindManyMock,
      postJobFindFirstMock,
      mediaFindManyMock,
      workspaceDeleteManyMock,
      executeRawMock,
    ]) {
      mock.mockReset();
    }
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    refusalCounts();
    postJobFindFirstMock.mockResolvedValue(null);
    delMock.mockImplementation(async () => {
      callLog.push("del");
    });
    workspaceDeleteManyMock.mockImplementation(async () => {
      callLog.push("delete-workspace");
      return { count: 1 };
    });
    memberFindManyMock.mockImplementation(async () => otherMembers);
    mediaFindManyMock.mockImplementation(async ({ where }: { where: MediaWhere }) =>
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
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 401 when signed out", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(429);
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
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
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("refuses with 409 when another owner exists", async () => {
    refusalCounts({ otherOwners: 1 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This workspace has another owner. Only a workspace with one owner can be deleted.",
    });
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("refuses with 409 while a post is publishing", async () => {
    postJobFindFirstMock.mockResolvedValue({ id: "job-1" });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A post is publishing right now. Try again in a few minutes.",
    });
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
  });

  it("refuses with 409 when it is the caller's last workspace", async () => {
    refusalCounts({ callerMemberships: 1 });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This is your only workspace. To leave Vibe Socials, delete your account instead.",
    });
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes the files before the rows, clears the cookie and returns 200", async () => {
    media = [
      { id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") },
      { id: "m2", workspaceId: "ws-1", storageLocation: FILE("b") },
    ];

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(callLog).toEqual(["del", "transaction", "delete-workspace"]);
    expect(delMock).toHaveBeenCalledWith([FILE("a"), FILE("b")], expect.anything());
    expect(workspaceDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["ws-1"] } } });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "",
      expect.objectContaining({ maxAge: 0, path: "/" }),
    );
  });

  it("keeps a file another workspace still uses", async () => {
    media = [
      { id: "m1", workspaceId: "ws-1", storageLocation: FILE("shared") },
      { id: "m2", workspaceId: "ws-1", storageLocation: FILE("mine") },
      { id: "m3", workspaceId: "ws-other", storageLocation: FILE("shared") },
    ];

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    expect(delMock).toHaveBeenCalledWith([FILE("mine")], expect.anything());
  });

  it("returns 500 and leaves the rows when a file deletion fails", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    delMock.mockRejectedValue(new Error("blob down"));

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not delete all of this workspace's files. Try again.",
    });
    expect(callLog).not.toContain("transaction");
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("gives a member left with no workspace a new personal one, in the same transaction", async () => {
    otherMembers = [
      { user: { id: "user-2", name: "Lonely", email: "lonely@example.com" } },
      { user: { id: "user-3", name: "Busy", email: "busy@example.com" } },
    ];
    remainingMemberships = { "user-2": 0, "user-3": 1 };
    provisionPersonalWorkspaceMock.mockImplementation(async () => {
      callLog.push("provision");
      return { workspaceId: "ws-new" };
    });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(200);
    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: { not: "user-1" } },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    expect(provisionPersonalWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(provisionPersonalWorkspaceMock).toHaveBeenCalledWith(expect.anything(), {
      id: "user-2",
      name: "Lonely",
      email: "lonely@example.com",
    });
    expect(callLog).toEqual(["transaction", "delete-workspace", "provision"]);
  });

  it("refuses with 409 when a post started publishing during the file cleanup", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    postJobFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-1" });

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A post is publishing right now. Try again in a few minutes.",
    });
    expect(postJobFindFirstMock).toHaveBeenCalledTimes(2);
    expect(workspaceDeleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("answers 500 with a finish-it sentence when the database step fails after the files went", async () => {
    media = [{ id: "m1", workspaceId: "ws-1", storageLocation: FILE("a") }];
    workspaceDeleteManyMock.mockRejectedValue(new Error("connection lost"));

    const response = await DELETE(deleteRequest({ confirmName: "Old name" }));

    expect(delMock).toHaveBeenCalled();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The files were removed, but the rest could not be finished. Try again to complete it.",
    });
    expect(cookieSetMock).not.toHaveBeenCalled();
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
    expect(workspaceDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(workspaceDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["ws-1"] } } });
    expect(delMock).toHaveBeenCalledWith([FILE("mine")], expect.anything());
    expect(postJobFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: { in: ["ws-1"] } }),
      }),
    );
  });
});
