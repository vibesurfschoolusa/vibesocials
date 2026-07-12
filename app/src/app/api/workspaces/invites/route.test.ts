import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/active/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/workspace`, and `@/lib/inviteToken` at module scope, so all three
// must be mocked before route.ts is imported below. `WorkspaceForbiddenError`
// and `INVITE_TTL_MS` are kept REAL via importActual (route.ts does
// `instanceof` checks / arithmetic against the real values).
const {
  findFirstMock,
  updateManyMock,
  createMock,
  transactionMock,
  getWorkspaceContextMock,
  generateInviteTokenMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  createMock: vi.fn(),
  transactionMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  generateInviteTokenMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceInvite: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      create: createMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace")>("@/lib/workspace");
  return {
    ...actual,
    getWorkspaceContext: getWorkspaceContextMock,
  };
});

vi.mock("@/lib/inviteToken", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inviteToken")>("@/lib/inviteToken");
  return {
    ...actual,
    generateInviteToken: generateInviteTokenMock,
  };
});

import { WorkspaceForbiddenError } from "@/lib/workspace";
import { INVITE_TTL_MS } from "@/lib/inviteToken";
import { DELETE, GET, POST } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

function makeInviteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "invite-1",
    workspaceId: "ws-1",
    tokenHash: "existing-hash",
    createdById: "user-1",
    expiresAt: new Date("2026-07-19T00:00:00Z"),
    revokedAt: null,
    usedCount: 0,
    createdAt: new Date("2026-07-12T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  createMock.mockReset();
  transactionMock.mockReset();
  getWorkspaceContextMock.mockReset();
  generateInviteTokenMock.mockReset();

  getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
  generateInviteTokenMock.mockReturnValue({ raw: "RAW_TOKEN_VALUE", hash: "hashed-token-value" });

  // Default transaction implementation: invoke the callback with a `tx`
  // whose methods are the same spies the tests assert against (mirrors
  // workspace.test.ts / media/[id]/route.test.ts).
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      workspaceInvite: { updateMany: updateManyMock, create: createMock },
    }),
  );

  delete process.env.NEXTAUTH_URL;
});

describe("GET /api/workspaces/invites", () => {
  it("returns 401 when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a member", async () => {
    getWorkspaceContextMock.mockRejectedValue(new WorkspaceForbiddenError());

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
  });

  it("returns { invite: null } when there is no active invite", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ invite: null });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns active invite metadata WITHOUT the raw token or tokenHash (url is always null)", async () => {
    findFirstMock.mockResolvedValue(makeInviteRow());

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      invite: {
        url: null,
        expiresAt: "2026-07-19T00:00:00.000Z",
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("hash");
  });
});

describe("POST /api/workspaces/invites", () => {
  it("returns 401 when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a member", async () => {
    getWorkspaceContextMock.mockRejectedValue(new WorkspaceForbiddenError());

    const response = await POST();

    expect(response.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("revokes prior active invites for this workspace before creating the new one (single-active policy)", async () => {
    createMock.mockResolvedValue(
      makeInviteRow({ tokenHash: "hashed-token-value", expiresAt: new Date(Date.now() + INVITE_TTL_MS) }),
    );

    await POST();

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        tokenHash: "hashed-token-value",
        createdById: "user-1",
        expiresAt: expect.any(Date),
      },
    });
    // Revoke-then-create happens inside one transaction.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const revokeOrder = updateManyMock.mock.invocationCallOrder[0];
    const createOrder = createMock.mock.invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(createOrder);
  });

  it("sets expiresAt to now + INVITE_TTL_MS", async () => {
    const before = Date.now();
    createMock.mockImplementation(async ({ data }: { data: { expiresAt: Date } }) => ({
      ...makeInviteRow(),
      expiresAt: data.expiresAt,
    }));

    const response = await POST();
    const after = Date.now();
    const body = await response.json();

    const expiresAtMs = new Date(body.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(after + INVITE_TTL_MS);
  });

  it("returns { url, expiresAt } with url built from NEXTAUTH_URL + the raw token", async () => {
    process.env.NEXTAUTH_URL = "https://vibesocials.example";
    createMock.mockResolvedValue(makeInviteRow({ expiresAt: new Date("2026-07-19T00:00:00Z") }));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: "https://vibesocials.example/join/RAW_TOKEN_VALUE",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });
  });

  it("falls back to a relative URL when NEXTAUTH_URL is unset", async () => {
    createMock.mockResolvedValue(makeInviteRow());

    const response = await POST();
    const body = await response.json();

    expect(body.url).toBe("/join/RAW_TOKEN_VALUE");
  });

  it("never includes tokenHash in the response", async () => {
    createMock.mockResolvedValue(makeInviteRow());

    const response = await POST();
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("returns 500 (not an unhandled rejection) when the transaction throws", async () => {
    transactionMock.mockRejectedValue(new Error("db down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to create invite" });

    consoleSpy.mockRestore();
  });
});

describe("DELETE /api/workspaces/invites", () => {
  it("returns 401 when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await DELETE();

    expect(response.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a member", async () => {
    getWorkspaceContextMock.mockRejectedValue(new WorkspaceForbiddenError());

    const response = await DELETE();

    expect(response.status).toBe(403);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("revokes the active invite scoped to the workspace and returns { ok: true }", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await DELETE();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("is idempotent: still returns 200 { ok: true } when there was nothing to revoke", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
