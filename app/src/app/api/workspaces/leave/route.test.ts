import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/switch/route.test.ts). route.ts imports `@/lib/db`,
// `@/lib/workspace`, `@/lib/rateLimit`, and `next/headers` at module scope,
// so all four must be mocked before route.ts is imported below.
const { deleteManyMock, getWorkspaceContextMock, checkRateLimitMock, cookieSetMock, cookiesMock } =
  vi.hoisted(() => ({
    deleteManyMock: vi.fn(),
    getWorkspaceContextMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    cookieSetMock: vi.fn(),
    cookiesMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { deleteMany: deleteManyMock },
  },
}));

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

import { POST } from "./route";

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
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();

  getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  deleteManyMock.mockResolvedValue({ count: 1 });
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
});

describe("POST /api/workspaces/leave", () => {
  it("returns 401 and never deletes when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("429s with Retry-After when the leave rate limit blocks", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await POST();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 120 });
    expect(deleteManyMock).not.toHaveBeenCalled(); // limited BEFORE any DB read
  });

  it("checks the per-user leave rate limit with the shared envelope", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });

    await POST();

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-2",
      route: "workspaces/leave",
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 400 and never deletes when the caller is the workspace owner", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer ownership before removing yourself.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("deletes the caller's own membership (role-guarded, scoped to the active workspace) and clears the active-workspace cookie on success", async () => {
    const response = await POST();
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

    const response = await POST();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(cookieSetMock).not.toHaveBeenCalled();
  });
});
