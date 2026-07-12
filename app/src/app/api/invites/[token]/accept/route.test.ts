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
  updateInviteMock,
  upsertMemberMock,
  transactionMock,
  cookieSetMock,
  cookiesMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findUniqueInviteMock: vi.fn(),
  updateInviteMock: vi.fn(),
  upsertMemberMock: vi.fn(),
  transactionMock: vi.fn(),
  cookieSetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceInvite: { findUnique: findUniqueInviteMock, update: updateInviteMock },
    workspaceMember: { upsert: upsertMemberMock },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
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
  updateInviteMock.mockReset();
  upsertMemberMock.mockReset();
  transactionMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();

  getCurrentUserMock.mockResolvedValue(USER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      workspaceInvite: { update: updateInviteMock },
      workspaceMember: { upsert: upsertMemberMock },
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
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns the SAME 404 message for an expired invite (no oracle)", async () => {
    findUniqueInviteMock.mockResolvedValue(
      makeInviteRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const response = await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("creates a member membership and increments usedCount inside one transaction, for a brand-new member", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ id: "invite-42", workspaceId: "ws-42" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateInviteMock).toHaveBeenCalledWith({
      where: { id: "invite-42" },
      data: { usedCount: { increment: 1 } },
    });
    expect(upsertMemberMock).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-42", userId: "user-1" } },
      create: { workspaceId: "ws-42", userId: "user-1", role: "member" },
      update: {},
    });
  });

  it("never downgrades an existing member/owner: the upsert's update branch is a no-op", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

    await POST(new Request("http://localhost", { method: "POST" }), ctx(RAW_TOKEN));

    const call = upsertMemberMock.mock.calls[0][0] as { update: unknown };
    expect(call.update).toEqual({});
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
    // The upsert's `update: {}` handles idempotency at the DB layer; the
    // route doesn't need to branch on prior membership at all — same call
    // shape regardless of whether the row already existed.
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ workspaceId: "ws-1" }));

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
    await expect(response.json()).resolves.toEqual({ error: "Failed to join workspace" });
    expect(cookieSetMock).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
