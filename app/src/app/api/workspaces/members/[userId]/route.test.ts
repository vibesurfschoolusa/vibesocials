import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/active/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/workspace` (the shared `requireOwnerContext` owner gate — review
// fix round 1, Minor 1; its 401/403 mapping is unit-tested in
// src/lib/workspace.test.ts), and `@/lib/rateLimit` (PATCH's per-user
// throttle) at module scope, so all three must be mocked before route.ts is
// imported below.
const {
  findFirstMock,
  deleteManyMock,
  updateManyMock,
  countMock,
  executeRawMock,
  requireOwnerContextMock,
  checkRateLimitMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  deleteManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  countMock: vi.fn(),
  executeRawMock: vi.fn(),
  requireOwnerContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  // $transaction replays the callback against this same object, so
  // `tx.<model>.<op>` inside the demote transaction resolves to these same
  // mocks (mirrors posting.test.ts / workspace.test.ts). `$executeRaw`
  // receives the `ws-owners:<workspaceId>` advisory lock the demote path takes.
  const prisma: Record<string, unknown> = {
    $executeRaw: executeRawMock,
    workspaceMember: {
      findFirst: findFirstMock,
      deleteMany: deleteManyMock,
      updateMany: updateManyMock,
      count: countMock,
    },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

import { DELETE, PATCH } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

function ctx(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

function patchReq(role: unknown) {
  return new Request("http://localhost", {
    method: "PATCH",
    body: JSON.stringify({ role }),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  findFirstMock.mockReset();
  deleteManyMock.mockReset();
  updateManyMock.mockReset();
  countMock.mockReset();
  executeRawMock.mockReset();
  requireOwnerContextMock.mockReset();
  checkRateLimitMock.mockReset();

  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findFirstMock.mockResolvedValue({ role: "member" });
  deleteManyMock.mockResolvedValue({ count: 1 });
  updateManyMock.mockResolvedValue({ count: 1 });
  // Default: at least one OTHER owner exists, so demote/self-demote is allowed
  // unless a test narrows the count to 1 (target is the last owner).
  countMock.mockResolvedValue(2);
  executeRawMock.mockResolvedValue(1);
});

describe("DELETE /api/workspaces/members/[userId]", () => {
  it("returns the gate's 401 response as-is when unauthenticated", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(401);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is for a member (owner-gated)", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the owner tries to remove themselves", async () => {
    const response = await DELETE(new Request("http://localhost"), ctx("user-1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer ownership before removing yourself.",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the target membership is an owner (review fix round 1 — future-proofs multi-owner states)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Owners can't be removed.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the target isn't a member of the active workspace", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost"), ctx("user-ghost"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-ghost" },
      select: { role: true },
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes via an atomic role-guarded delete scoped to the active workspace and target user, returns 200 { ok: true }", async () => {
    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // The role guard is repeated IN the delete's where clause so a
    // concurrent promotion between the read and the delete can't remove an
    // owner (conditional-mutation pattern, same as the posts cancel route).
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: { not: "owner" } },
    });
  });

  it("returns 404 when the atomic delete matches nothing (membership raced away)", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("PATCH /api/workspaces/members/[userId]", () => {
  it("returns the gate's 401 response as-is when unauthenticated (no rate-limit, no db work)", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is for a member (owner-gated)", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("checks the per-user members rate limit with the shared envelope, after the owner gate", async () => {
    await PATCH(patchReq("member"), ctx("user-2"));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "workspaces/members",
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("429s with Retry-After and does no db work when the members rate limit blocks", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please slow down.",
      retryAfterSeconds: 120,
    });
    expect(findFirstMock).not.toHaveBeenCalled(); // limited BEFORE any membership read
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a role outside the enum, without reading membership", async () => {
    const response = await PATCH(patchReq("superadmin"), ctx("user-2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid role." });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 (no existence oracle) when the target isn't a member of the active workspace", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await PATCH(patchReq("owner"), ctx("user-ghost"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-ghost" },
      select: { role: true },
    });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op (200, NO write) when the target already has the requested role — owner", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, role: "owner" });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op (200, NO write) when the target already has the requested role — member", async () => {
    findFirstMock.mockResolvedValue({ role: "member" });

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member" });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it("promotes a member to owner via a role-guarded updateMany, with NO advisory lock (adding an owner can't zero owners)", async () => {
    findFirstMock.mockResolvedValue({ role: "member" });
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, role: "owner" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: "member" },
      data: { role: "owner" },
    });
    // Promotion takes no lock and opens no transaction.
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("returns 404 when a promote's conditional updateMany matches nothing (member raced away)", async () => {
    findFirstMock.mockResolvedValue({ role: "member" });
    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(patchReq("owner"), ctx("user-2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("demote: takes the ws-owners advisory lock FIRST, then re-reads the owner count INSIDE the transaction", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 1 });

    await PATCH(patchReq("member"), ctx("user-2"));

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    // $executeRaw is a tagged-template call: (TemplateStringsArray, ...values).
    const [strings, lockKey] = executeRawMock.mock.calls[0] as [readonly string[], string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(");
    expect(lockKey).toBe("ws-owners:ws-1");
    expect(countMock).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", role: "owner" } });
    // Lock STRICTLY precedes the owner-count read, which precedes the update.
    const lockOrder = executeRawMock.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countMock.mock.invocationCallOrder[0]);
    expect(countMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateManyMock.mock.invocationCallOrder[0],
    );
  });

  it("refuses (400, no write) to demote the last owner — owner count 1 inside the lock", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(1);

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Promote another owner first." });
    // The lock was taken, but the guard tripped before any write.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("demotes an owner to member via a role-guarded updateMany when another owner exists (count >= 2)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: "owner" },
      data: { role: "member" },
    });
  });

  it("allows self-demotion through the same last-owner guard when another owner exists", async () => {
    // Target is the caller themselves (OWNER_CONTEXT.user.id === "user-1").
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(patchReq("member"), ctx("user-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-1", role: "owner" },
      data: { role: "member" },
    });
  });

  it("blocks self-demotion by the same guard when the caller is the last owner (400, no write)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(1);

    const response = await PATCH(patchReq("member"), ctx("user-1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Promote another owner first." });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when a demote's conditional updateMany matches nothing (owner raced away under the lock)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
