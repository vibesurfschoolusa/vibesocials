import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/switch/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/workspace`, `@/lib/rateLimit`, and `next/headers` at module scope,
// so all four must be mocked before route.ts is imported below. The
// owner-leave path adds a `$transaction` + `$executeRaw` advisory lock and a
// `count` / `findFirst` / `delete` on workspaceMember (the member fast path
// still uses only `deleteMany`).
const {
  deleteManyMock,
  countMock,
  findFirstMock,
  deleteMock,
  executeRawMock,
  getWorkspaceContextMock,
  checkRateLimitMock,
  cookieSetMock,
  cookiesMock,
  payerRefusalMock,
  noticeMock,
  inviteUpdateManyMock,
} = vi.hoisted(() => ({
  inviteUpdateManyMock: vi.fn(),
  noticeMock: vi.fn(),
  payerRefusalMock: vi.fn(),
  deleteManyMock: vi.fn(),
  countMock: vi.fn(),
  findFirstMock: vi.fn(),
  deleteMock: vi.fn(),
  executeRawMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  cookieSetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  // $transaction replays the callback against this same object, so
  // `tx.<model>.<op>` inside the owner-leave transaction resolves to these
  // same mocks (mirrors posting.test.ts). `$executeRaw` receives the
  // `ws-owners:<workspaceId>` advisory lock — the SAME key PATCH's demote path
  // uses, so a demote and an owner-leave on one workspace serialize.
  const prisma: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    workspaceMember: {
      deleteMany: deleteManyMock,
      count: countMock,
      findFirst: findFirstMock,
      delete: deleteMock,
    },
    workspaceInvite: { updateMany: inviteUpdateManyMock },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));
// R5-security L2: the Stripe side is tested in server/billing/payerRefusal.test.ts.
vi.mock("@/server/billing/payerRefusal", () => ({ payerRefusal: payerRefusalMock }));
// R5-security L1: the email itself is tested in ../members/formerOwnerNotice.test.ts.
vi.mock("../members/formerOwnerNotice", () => ({ noticeOwnersOfFormerOwner: noticeMock }));

import { POST } from "./route";

/** The Team card sends the workspace its page was rendered for (F3). */
function leaveReq(body: unknown = { workspaceId: "ws-1" }) {
  return new Request("http://localhost/api/workspaces/leave", {
    method: "POST",
    ...(body === null ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

const MEMBER_CONTEXT = {
  user: { id: "user-2", email: "member@example.com", name: "Member" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
  memberCount: 2,
};

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

beforeEach(() => {
  deleteManyMock.mockReset();
  countMock.mockReset();
  findFirstMock.mockReset();
  deleteMock.mockReset();
  executeRawMock.mockReset();
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();

  getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  deleteManyMock.mockResolvedValue({ count: 1 });
  // Owner-leave defaults: one OTHER owner exists, and the caller's own
  // membership row resolves to an id for the by-id delete.
  countMock.mockResolvedValue(1);
  findFirstMock.mockResolvedValue({ id: "member-row-1" });
  deleteMock.mockResolvedValue({ id: "member-row-1" });
  executeRawMock.mockResolvedValue(1);
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
  payerRefusalMock.mockReset();
  payerRefusalMock.mockResolvedValue(null);
  noticeMock.mockReset();
  noticeMock.mockResolvedValue({ clientLinksToReplace: true });
  inviteUpdateManyMock.mockReset();
  inviteUpdateManyMock.mockResolvedValue({ count: 1 });
});

// R7-security L4: like removal, leaving turns off the invite links the person
// made, in the same transaction, so they can't rejoin with a copy.
describe("POST /api/workspaces/leave turns off the leaver's invite links", () => {
  const REVOKE_WHERE = { workspaceId: "ws-1", createdById: "user-1", revokedAt: null };

  it("for an owner who leaves, after their row is gone, and tells the owners how many", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    const response = await POST(leaveReq());
    expect(response.status).toBe(200);
    expect(inviteUpdateManyMock).toHaveBeenCalledWith({ where: REVOKE_WHERE, data: { revokedAt: expect.any(Date) } });
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(inviteUpdateManyMock.mock.invocationCallOrder[0]);
    expect(noticeMock).toHaveBeenCalledWith(expect.objectContaining({ joinLinksRevoked: 1 }));
  });

  it("for a member who leaves (a demoted owner may have made some)", async () => {
    const response = await POST(leaveReq());
    expect(response.status).toBe(200);
    expect(inviteUpdateManyMock).toHaveBeenCalledWith({
      where: { ...REVOKE_WHERE, createdById: "user-2" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(deleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(inviteUpdateManyMock.mock.invocationCallOrder[0]);
  });

  it("not when nothing was left: a sole owner refused, or a membership that raced away", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    countMock.mockResolvedValue(0);
    await POST(leaveReq());
    getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
    deleteManyMock.mockResolvedValue({ count: 0 });
    await POST(leaveReq());
    expect(inviteUpdateManyMock).not.toHaveBeenCalled();
  });
});

// R5-security L1: an owner who leaves could copy the client links, which keep working.
describe("POST /api/workspaces/leave tells the remaining owners about the client links", () => {
  it("after an owner leaves, once the row is gone", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST(leaveReq());

    expect(response.status).toBe(200);
    expect(noticeMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workspaceName: "Acme",
      formerOwnerId: "user-1",
      at: expect.any(Date),
      joinLinksRevoked: 1,
    });
    expect(deleteMock.mock.invocationCallOrder[0]).toBeLessThan(noticeMock.mock.invocationCallOrder[0]);
  });

  it("not for a member who leaves, nor for a sole owner who is refused", async () => {
    await POST(leaveReq());
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    countMock.mockResolvedValue(0);
    await POST(leaveReq());
    expect(noticeMock).not.toHaveBeenCalled();
  });
});

// R5-security L2: a person whose card pays for this workspace's plan must hand
// it over or cancel it before going, or the card keeps paying.
describe("POST /api/workspaces/leave while the caller pays for the plan", () => {
  it("asks about this workspace and the caller", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    await POST(leaveReq());
    expect(payerRefusalMock).toHaveBeenCalledWith({ userId: "user-1", workspaceIds: ["ws-1"] });
  });

  it.each([
    [409, "You pay for Acme's plan. Cancel it under Settings, Plan first (it stays active until the end of the period); another owner can then start their own plan."],
  ])("answers %i with the sentence and leaves nothing", async (status, error) => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    payerRefusalMock.mockResolvedValue({ status, error });

    const response = await POST(leaveReq());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("holds back a member who pays too", async () => {
    payerRefusalMock.mockResolvedValue({ status: 409, error: "pays" });
    expect((await POST(leaveReq())).status).toBe(409);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/leave", () => {
  it("returns 401 and never deletes when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(leaveReq());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("429s with Retry-After when the leave rate limit blocks", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await POST(leaveReq());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 120 });
    expect(deleteManyMock).not.toHaveBeenCalled(); // limited BEFORE any DB read
  });

  it("checks the per-user leave rate limit with the shared envelope", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });

    await POST(leaveReq());

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-2",
      route: "workspaces/leave",
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 400 and deletes nothing when the caller is the SOLE owner (no other owner to inherit)", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    countMock.mockResolvedValue(0); // zero OTHER owners

    const response = await POST(leaveReq());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer ownership before removing yourself.",
    });
    // The last-owner guard runs INSIDE the advisory-locked transaction; no row
    // is deleted through either path.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("lets an owner leave when another owner exists: takes the ws-owners lock FIRST, deletes own row by id, clears the cookie", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    countMock.mockResolvedValue(1); // one OTHER owner remains
    findFirstMock.mockResolvedValue({ id: "member-row-1" });

    const response = await POST(leaveReq());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ left: true });

    // Advisory lock is the SAME key PATCH's demote path uses, and is issued
    // FIRST — before the owner-count re-read that gates the leave.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [strings, lockKey] = executeRawMock.mock.calls[0] as [readonly string[], string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(");
    expect(lockKey).toBe("ws-owners:ws-1");
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      countMock.mock.invocationCallOrder[0],
    );

    // Only the OTHER owners are counted (the caller is excluded).
    expect(countMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner", userId: { not: "user-1" } },
    });

    // Own membership deleted BY ID — not the role: "member" guarded deleteMany
    // the member fast path uses (an owner's row would never match that guard).
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "member-row-1" } });
    expect(deleteManyMock).not.toHaveBeenCalled();

    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    );
  });

  it("returns 404 without clearing the cookie when the owner's own row raced away under the lock", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
    countMock.mockResolvedValue(1);
    findFirstMock.mockResolvedValue(null); // own row already gone

    const response = await POST(leaveReq());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("deletes the caller's own membership (role-guarded, scoped to the active workspace) and clears the active-workspace cookie on success", async () => {
    const response = await POST(leaveReq());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ left: true });
    // The role guard is repeated IN the delete's where clause (same
    // conditional-mutation / defense-in-depth pattern as DELETE
    // /api/workspaces/members/[userId]) so a concurrent promotion between
    // the context read and the delete can't remove an owner's membership
    // through this route.
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: "member" },
    });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    );
  });

  it("returns 404 and never touches the cookie when the delete matches nothing (membership raced away)", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const response = await POST(leaveReq());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(cookieSetMock).not.toHaveBeenCalled();
  });
});

// F3 (2026-11-14 review): Leave acts on the active workspace, a cookie every
// tab shares, so it must name the workspace its page was rendered for.
describe("POST /api/workspaces/leave and the rendered workspace", () => {
  it("409s another workspace's id, and leaves nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);

    const response = await POST(leaveReq({ workspaceId: "ws-2" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", null],
    ["a body without the id", {}],
  ])("400s %s, and leaves nothing", async (_label, body) => {
    getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);

    const response = await POST(leaveReq(body));

    expect(response.status).toBe(400);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });
});
