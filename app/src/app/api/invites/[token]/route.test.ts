import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts). route.ts imports `@/lib/auth` and `@/lib/db` at
// module scope, so both must be mocked before route.ts is imported below.
// `@/lib/inviteToken`'s `hashInviteToken` is kept REAL (pure sha256) so the
// test can assert the exact hash the route looks up by.
const { getCurrentUserMock, findUniqueInviteMock, findFirstMembershipMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  findUniqueInviteMock: vi.fn(),
  findFirstMembershipMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceInvite: { findUnique: findUniqueInviteMock },
    workspaceMember: { findFirst: findFirstMembershipMock },
  },
}));

import { hashInviteToken } from "@/lib/inviteToken";
import { GET } from "./route";

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
    workspace: { id: "ws-1", name: "Acme" },
    ...overrides,
  };
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  findUniqueInviteMock.mockReset();
  findFirstMembershipMock.mockReset();

  getCurrentUserMock.mockResolvedValue(USER);
});

describe("GET /api/invites/[token]", () => {
  it("returns 401 and never looks up the invite when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx(RAW_TOKEN));

    expect(response.status).toBe(401);
    expect(findUniqueInviteMock).not.toHaveBeenCalled();
  });

  it("looks up the invite by the SHA-256 hash of the raw token from the URL", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());
    findFirstMembershipMock.mockResolvedValue(null);

    await GET(new Request("http://localhost"), ctx(RAW_TOKEN));

    expect(findUniqueInviteMock).toHaveBeenCalledWith({
      where: { tokenHash: hashInviteToken(RAW_TOKEN) },
      include: { workspace: { select: { id: true, name: true } } },
    });
  });

  it("returns 404 with a generic message when the token matches no invite", async () => {
    findUniqueInviteMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx("unknown-token"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
    expect(findFirstMembershipMock).not.toHaveBeenCalled();
  });

  it("returns the SAME 404 message for a revoked invite (no oracle)", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow({ revokedAt: new Date() }));

    const response = await GET(new Request("http://localhost"), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
  });

  it("returns the SAME 404 message for an expired invite (no oracle)", async () => {
    findUniqueInviteMock.mockResolvedValue(
      makeInviteRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const response = await GET(new Request("http://localhost"), ctx(RAW_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This invite link is invalid or has expired.",
    });
  });

  it("returns { workspaceName, alreadyMember: false } for a valid invite when the caller isn't a member yet", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());
    findFirstMembershipMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx(RAW_TOKEN));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ workspaceName: "Acme", alreadyMember: false });
    expect(findFirstMembershipMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-1" },
    });
  });

  it("returns { alreadyMember: true } when the caller already belongs to the invite's workspace", async () => {
    findUniqueInviteMock.mockResolvedValue(makeInviteRow());
    findFirstMembershipMock.mockResolvedValue({ id: "member-1" });

    const response = await GET(new Request("http://localhost"), ctx(RAW_TOKEN));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ workspaceName: "Acme", alreadyMember: true });
  });
});
