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
  inviteUpdateManyMock,
  transactionSpy,
  executeRawMock,
  requireOwnerContextMock,
  checkRateLimitMock,
  noticeMock,
  payerRefusalMock,
} = vi.hoisted(() => ({
  noticeMock: vi.fn(),
  payerRefusalMock: vi.fn(),
  findFirstMock: vi.fn(),
  deleteManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  countMock: vi.fn(),
  inviteUpdateManyMock: vi.fn(),
  transactionSpy: vi.fn(),
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
    // 2026-11-01 audit (Task 8): member removal revokes the workspace's active
    // invite links in the same transaction.
    workspaceInvite: { updateMany: inviteUpdateManyMock },
    $transaction: (cb: (tx: unknown) => unknown) => {
      transactionSpy();
      return cb(prisma);
    },
  };
  return { prisma };
});

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));
// R5-security L1: the email itself is tested in ../formerOwnerNotice.test.ts.
vi.mock("../formerOwnerNotice", () => ({ noticeOwnersOfFormerOwner: noticeMock }));
// R6-security L1: the payer rule is tested in server/billing/payerRefusal.test.ts.
vi.mock("@/server/billing/payerRefusal", () => ({ payerRefusal: payerRefusalMock }));

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

/** The Team card sends the workspace its page was rendered for (F3). */
function patchReq(role: unknown, workspaceId: unknown = "ws-1") {
  return new Request("http://localhost", {
    method: "PATCH",
    body: JSON.stringify({ role, workspaceId }),
    headers: { "content-type": "application/json" },
  });
}

function deleteReq(body: unknown = { workspaceId: "ws-1" }) {
  return new Request("http://localhost", {
    method: "DELETE",
    ...(body === null ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

beforeEach(() => {
  findFirstMock.mockReset();
  deleteManyMock.mockReset();
  updateManyMock.mockReset();
  countMock.mockReset();
  inviteUpdateManyMock.mockReset();
  transactionSpy.mockReset();
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
  inviteUpdateManyMock.mockResolvedValue({ count: 1 });
  noticeMock.mockReset();
  noticeMock.mockResolvedValue({ clientLinksToReplace: false });
  payerRefusalMock.mockReset();
  payerRefusalMock.mockResolvedValue(null);
});

describe("DELETE /api/workspaces/members/[userId]", () => {
  it("returns the gate's 401 response as-is when unauthenticated", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await DELETE(deleteReq(), ctx("user-2"));

    expect(response.status).toBe(401);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is for a member (owner-gated)", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await DELETE(deleteReq(), ctx("user-2"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the owner tries to remove themselves", async () => {
    const response = await DELETE(deleteReq(), ctx("user-1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer ownership before removing yourself.",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the target membership is an owner (review fix round 1 — future-proofs multi-owner states)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });

    const response = await DELETE(deleteReq(), ctx("user-2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Owners can't be removed.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the target isn't a member of the active workspace", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await DELETE(deleteReq(), ctx("user-ghost"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-ghost" },
      select: { role: true },
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes via an atomic role-guarded delete scoped to the active workspace and target user, returns 200 { ok: true }", async () => {
    const response = await DELETE(deleteReq(), ctx("user-2"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, invitesRevoked: 1 });
    // The role guard is repeated IN the delete's where clause so a
    // concurrent promotion between the read and the delete can't remove an
    // owner (conditional-mutation pattern, same as the posts cancel route).
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: { not: "owner" } },
    });
  });

  // R6-security L1: a co-owner could demote the payer and then remove them,
  // leaving their card paying for a workspace they are no longer in.
  it("refuses (409, no delete) removing the member who pays for the running plan", async () => {
    const sentence =
      "This member pays for Acme's plan. They cancel it with Manage your payment in Settings first (it stays active until the end of the period); you can then remove them, and another owner can start their own plan.";
    payerRefusalMock.mockResolvedValue({ status: 409, error: sentence });

    const response = await DELETE(deleteReq(), ctx("user-2"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: sentence });
    expect(payerRefusalMock).toHaveBeenCalledWith({ userId: "user-2", workspaceIds: ["ws-1"], removedByOther: true });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(inviteUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the atomic delete matches nothing (membership raced away) and revokes NO invites", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(deleteReq(), ctx("user-2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(inviteUpdateManyMock).not.toHaveBeenCalled();
  });

  describe("revokes the workspace's invite links (2026-11-01 audit, Task 8)", () => {
    it("revokes every active (unrevoked) invite of the active workspace and reports how many", async () => {
      inviteUpdateManyMock.mockResolvedValue({ count: 2 });

      const response = await DELETE(deleteReq(), ctx("user-2"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, invitesRevoked: 2 });
      expect(inviteUpdateManyMock).toHaveBeenCalledTimes(1);
      expect(inviteUpdateManyMock).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("reports invitesRevoked: 0 when there was no active invite", async () => {
      inviteUpdateManyMock.mockResolvedValue({ count: 0 });

      const response = await DELETE(deleteReq(), ctx("user-2"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, invitesRevoked: 0 });
    });

    it("removes the member and revokes the invites inside ONE transaction, member first", async () => {
      const order: string[] = [];
      deleteManyMock.mockImplementation(async () => {
        order.push("delete-member");
        return { count: 1 };
      });
      inviteUpdateManyMock.mockImplementation(async () => {
        order.push("revoke-invites");
        return { count: 1 };
      });

      await DELETE(deleteReq(), ctx("user-2"));

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["delete-member", "revoke-invites"]);
    });

    it("does NOT revoke invites when the removal is refused (self / owner target / not a member)", async () => {
      await DELETE(deleteReq(), ctx("user-1")); // self
      findFirstMock.mockResolvedValueOnce({ role: "owner" });
      await DELETE(deleteReq(), ctx("user-9")); // owner target
      findFirstMock.mockResolvedValueOnce(null);
      await DELETE(deleteReq(), ctx("user-ghost")); // non-member

      expect(inviteUpdateManyMock).not.toHaveBeenCalled();
    });
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

  it.each([
    ["null", "null"],
    ["an array", '["owner"]'],
    ["a string", '"owner"'],
    ["syntactically invalid JSON", "{not json"],
  ])("returns 400 'Invalid JSON body' for a body of %s, without reading membership", async (_label, raw) => {
    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: raw,
        headers: { "content-type": "application/json" },
      }),
      ctx("user-2"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
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
    // The Team card reads the client links itself after a demotion (Check 4).
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member", joinLinksRevoked: 1 });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: "owner" },
      data: { role: "member" },
    });
  });

  // R5-security L1: a demoted owner could copy the client links, which keep working.
  it("after a demotion, tells the other owners; the answer no longer carries clientLinksToReplace", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    noticeMock.mockResolvedValue({ clientLinksToReplace: true });

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(200);
    // R9-client-journey L1: how many invite links it turned off, so the Team card drops the one it shows.
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member", joinLinksRevoked: 1 });
    expect(noticeMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workspaceName: "Acme",
      formerOwnerId: "user-2",
      at: expect.any(Date),
      joinLinksRevoked: 1,
      demoted: true,
    });
  });

  // R8-client-journey L1 / security L2: as on leave, the invite links they made stop working.
  it("a demotion turns off the invite links the demoted owner made, inside the same transaction, after the role change", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });
    inviteUpdateManyMock.mockResolvedValue({ count: 2 });

    const response = await PATCH(patchReq("member"), ctx("user-2"));

    expect(response.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(inviteUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(inviteUpdateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", createdById: "user-2", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(inviteUpdateManyMock.mock.invocationCallOrder[0]);
    expect(noticeMock).toHaveBeenCalledWith(expect.objectContaining({ joinLinksRevoked: 2, demoted: true }));
  });

  it("turns off no invite link for a promotion, a refused demotion or a raced one", async () => {
    await PATCH(patchReq("owner"), ctx("user-2"));
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(1);
    await PATCH(patchReq("member"), ctx("user-2"));
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 0 });
    await PATCH(patchReq("member"), ctx("user-2"));
    expect(inviteUpdateManyMock).not.toHaveBeenCalled();
  });

  it("sends no notice for a promotion, a refused demotion or a raced one", async () => {
    await PATCH(patchReq("owner"), ctx("user-2"));
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(1);
    await PATCH(patchReq("member"), ctx("user-2"));
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 0 });
    await PATCH(patchReq("member"), ctx("user-2"));
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("allows self-demotion through the same last-owner guard when another owner exists", async () => {
    // Target is the caller themselves (OWNER_CONTEXT.user.id === "user-1").
    findFirstMock.mockResolvedValue({ role: "owner" });
    countMock.mockResolvedValue(2);
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(patchReq("member"), ctx("user-1"));

    expect(response.status).toBe(200);
    // The Team card reads the client links itself after a demotion (Check 4).
    await expect(response.json()).resolves.toEqual({ ok: true, role: "member", joinLinksRevoked: 1 });
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

// F3 (2026-11-14 review): the active workspace is one cookie for every tab,
// and one person can be a member of both workspaces, so a Remove, Promote or
// Demote clicked in a tab left on workspace A must not act in workspace B.
describe("members/[userId] and the rendered workspace", () => {
  function nothingChanged() {
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inviteUpdateManyMock).not.toHaveBeenCalled();
  }

  it("DELETE 409s another workspace's id, and removes nobody", async () => {
    const response = await DELETE(deleteReq({ workspaceId: "ws-2" }), ctx("user-2"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    nothingChanged();
  });

  it.each([
    ["no body", null],
    ["a body without the id", {}],
  ])("DELETE 400s %s, and removes nobody", async (_label, body) => {
    const response = await DELETE(deleteReq(body), ctx("user-2"));
    expect(response.status).toBe(400);
    nothingChanged();
  });

  it.each(["owner", "member"])("PATCH to %s 409s another workspace's id, and changes no role", async (role) => {
    const response = await PATCH(patchReq(role, "ws-2"), ctx("user-2"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    nothingChanged();
  });

  it("PATCH 400s a body without the id, and changes no role", async () => {
    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ role: "owner" }),
        headers: { "content-type": "application/json" },
      }),
      ctx("user-2"),
    );
    expect(response.status).toBe(400);
    nothingChanged();
  });
});
