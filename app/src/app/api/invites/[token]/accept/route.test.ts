import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// posts/route.test.ts's rateLimit mock idiom + workspace.test.ts's cookies
// mock idiom). route.ts imports `@/lib/auth`, `@/lib/db`, `@/lib/rateLimit`,
// `@/lib/workspace` (for `ACTIVE_WORKSPACE_COOKIE` only), and `next/headers`
// at module scope, so all must be mocked before route.ts is imported below.
// `@/lib/inviteToken`'s `hashInviteToken` is kept REAL (pure sha256).
const {
  getCurrentUserMock,
  checkRateLimitMock,
  findUniqueInviteMock,
  updateManyInviteMock,
  createMemberMock,
  makerMock,
  transactionMock,
  cookieSetMock,
  cookiesMock,
  notifyJoinedMock,
} = vi.hoisted(() => ({
  notifyJoinedMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueInviteMock: vi.fn(),
  updateManyInviteMock: vi.fn(),
  createMemberMock: vi.fn(),
  makerMock: vi.fn(),
  transactionMock: vi.fn(),
  cookieSetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

// R10: the one rule (inviteMaker.ts), spied so the test sees Join call it.
const inviteLinkWorksSpy = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../inviteMaker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../inviteMaker")>();
  inviteLinkWorksSpy.fn.mockImplementation(actual.inviteLinkWorks);
  return { ...actual, inviteLinkWorks: inviteLinkWorksSpy.fn };
});

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceInvite: { findUnique: findUniqueInviteMock },
    workspaceMember: { createMany: createMemberMock },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@/server/notifications/memberJoinedEmail", () => ({
  notifyOwnersOfMemberJoined: notifyJoinedMock,
}));

import { hashInviteToken } from "@/lib/inviteToken";
import { POST } from "./route";

const USER = { id: "user-1", email: "invitee@example.com", name: "Invitee" };
const RAW_TOKEN = "some-raw-token-value";

function makeInviteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "invite-1",
    workspaceId: "ws-1",
    tokenHash: hashInviteToken(RAW_TOKEN),
    createdById: "owner-1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    usedCount: 0,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  findUniqueInviteMock.mockReset();
  updateManyInviteMock.mockReset();
  createMemberMock.mockReset();
  transactionMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();
  notifyJoinedMock.mockReset();
  notifyJoinedMock.mockResolvedValue(undefined);
  // A brand-new member by default: the insert added one row.
  createMemberMock.mockResolvedValue({ count: 1 });
  // The link's maker is still an owner by default.
  makerMock.mockReset();
  makerMock.mockResolvedValue(1);

  getCurrentUserMock.mockResolvedValue(USER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
  // The conditional in-transaction re-validation (review fix round 1) matched
  // the still-active invite row by default.
  updateManyInviteMock.mockResolvedValue({ count: 1 });
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      workspaceInvite: { updateMany: updateManyInviteMock },
      workspaceMember: { createMany: createMemberMock, count: makerMock },
    }),
  );
});

describe("POST /api/invites/[token]/accept", () => {
  it("returns 401 and never checks the rate limit when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("checks the rate limit under route invites/accept, 10/5min, keyed by user id", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "invites/accept",
      limit: 10,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 429 with Retry-After and never validates the token when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(findUniqueInviteMock).not.toHaveBeenCalled();
  });

  it("looks up the invite by the SHA-256 hash of the raw token from the URL", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(findUniqueInviteMock).toHaveBeenCalledWith({
      where: { tokenHash: hashInviteToken(RAW_TOKEN) },
    });
  });

  it("returns 404 with a generic message when the token matches no invite", async () => {
    findUniqueInviteMock.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx("unknown"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME 404 message for a revoked invite (no oracle)", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ revokedAt: new Date() }));

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
    // R10: inviteLinkWorks refuses it inside the transaction, before anything is written.
    expect(updateManyInviteMock).not.toHaveBeenCalled();
    expect(createMemberMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("returns the SAME 404 message for an expired invite (no oracle)", async () => {
    findUniqueInviteMock.mockResolvedValue(
      makeInviteRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    expect(updateManyInviteMock).not.toHaveBeenCalled();
    expect(createMemberMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("creates a member membership and increments usedCount inside one transaction, for a brand-new member", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ id: "invite-42", workspaceId: "ws-42" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(transactionMock).toHaveBeenCalledTimes(1);
    // Review fix round 1 (Important 1): the increment is a CONDITIONAL
    // mutation that re-validates revocation + expiry INSIDE the transaction,
    // so a revoke landing between the fast-path read and the commit can
    // never still grant membership.
    expect(updateManyInviteMock).toHaveBeenCalledWith({
      where: { id: "invite-42", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedCount: { increment: 1 } },
    });
    expect(createMemberMock).toHaveBeenCalledWith({
      data: [{ workspaceId: "ws-42", userId: "user-1", role: "member" }],
      skipDuplicates: true,
    });
    // The membership upsert happens strictly AFTER the guard matched.
    expect(updateManyInviteMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMemberMock.mock.invocationCallOrder[0],
    );
  });

  it("returns the SAME uniform 404 — no upsert, no cookie — when the in-transaction re-check loses to a concurrent revoke/expiry (count 0)", async () => {
    // The fast-path read saw an active invite, but by the time the
    // transaction ran, a concurrent revoke (or expiry) made the conditional
    // updateMany match nothing.
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));
    updateManyInviteMock.mockResolvedValue({ count: 0 });

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
    expect(createMemberMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("never downgrades an existing member/owner: an existing row is skipped, never updated", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    const call = createMemberMock.mock.calls[0][0] as { skipDuplicates: unknown };
    expect(call.skipDuplicates).toBe(true);
  });

  // R2-client-journey L3: the owners are told about each new member, once.
  it("emails the owners about a brand-new member", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(notifyJoinedMock).toHaveBeenCalledTimes(1);
    expect(notifyJoinedMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      member: { name: "Invitee", email: "invitee@example.com" },
    });
  });

  it("sends no email when the person was already a member", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));
    createMemberMock.mockResolvedValue({ count: 0 });

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(200);
    expect(notifyJoinedMock).not.toHaveBeenCalled();
  });

  it("sends no email when the invite died in the transaction", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));
    updateManyInviteMock.mockResolvedValue({ count: 0 });

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(notifyJoinedMock).not.toHaveBeenCalled();
  });

  it("sets the active-workspace cookie to the invite's workspace", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "ws-1",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      }),
    );
  });

  it("returns 200 { joined: true, workspaceId } on success", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ joined: true, workspaceId: "ws-1" });
  });

  it("is idempotent for an already-existing member: still 200 { joined: true, workspaceId }, still sets the cookie", async () => {
    // skipDuplicates handles idempotency at the DB layer: the existing row is
    // left alone and the response is the same.
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));
    createMemberMock.mockResolvedValue({ count: 0 });

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ joined: true, workspaceId: "ws-1" });
    expect(cookieSetMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 (not an unhandled rejection) and never sets the cookie when the transaction throws", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));
    transactionMock.mockRejectedValue(new Error("db down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(500);
    // R11-client-journey L3: the sentence the Join page shows, with its next step.
    await expect(response.json()).resolves.toEqual({
      error: "You weren't added to the workspace. Please press Join workspace again in a minute.",
    });
    expect(cookieSetMock).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // R9-client-journey L6: a link made by someone who is no longer an owner of
  // the workspace (demoted or gone, also before demotion revoked links) adds nobody.
  it("refuses a link whose maker is no longer an owner: 404 with its own sentence, nothing written, no cookie", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-7", createdById: "former-owner" }));
    makerMock.mockResolvedValue(0);

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is no longer active. Ask an owner for a new one.",
    });
    expect(makerMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-7", userId: "former-owner", role: "owner" },
    });
    expect(updateManyInviteMock).not.toHaveBeenCalled();
    expect(createMemberMock).not.toHaveBeenCalled();
    expect(notifyJoinedMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("checks the maker inside the transaction, before the link is used", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(200);
    expect(makerMock.mock.invocationCallOrder[0]).toBeLessThan(updateManyInviteMock.mock.invocationCallOrder[0]);
  });

  // R10 (lead): Join applies the one rule, inviteLinkWorks, with the transaction's client.
  it("checks the link with inviteLinkWorks inside the transaction", async () => {
    inviteLinkWorksSpy.fn.mockClear();
    const row = makeInviteRow();
    findUniqueInviteMock.mockResolvedValue(row);

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(inviteLinkWorksSpy.fn).toHaveBeenCalledTimes(1);
    const [db, invite] = inviteLinkWorksSpy.fn.mock.calls[0];
    expect(invite).toBe(row);
    expect((db as { workspaceMember: { count: unknown } }).workspaceMember.count).toBe(makerMock);
  });
});
