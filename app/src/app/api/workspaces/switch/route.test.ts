import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/route.test.ts). route.ts imports `@/lib/db`, `@/lib/workspace`,
// `@/lib/rateLimit`, and `next/headers` at module scope, so all four must be
// mocked before route.ts is imported below.
const { findFirstMock, getWorkspaceContextMock, checkRateLimitMock, cookieSetMock, cookiesMock } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    getWorkspaceContextMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    cookieSetMock: vi.fn(),
    cookiesMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findFirst: findFirstMock },
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

const CONTEXT = {
  user: { id: "user-1", email: "member@example.com", name: "Member" },
  workspace: { id: "ws-personal", name: "Personal", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 1,
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/workspaces/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  findFirstMock.mockReset();
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  cookieSetMock.mockReset();
  cookiesMock.mockReset();

  getWorkspaceContextMock.mockResolvedValue(CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
});

describe("POST /api/workspaces/switch", () => {
  it("returns 401 and never checks membership when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ workspaceId: "ws-invited" }));

    expect(response.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("429s with Retry-After when the switch rate limit blocks", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await POST(jsonRequest({ workspaceId: "ws-2" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 120 });
    expect(findFirstMock).not.toHaveBeenCalled(); // limited BEFORE any DB read
  });

  it("checks the per-user switch rate limit with the shared envelope", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });

    await POST(jsonRequest({ workspaceId: "ws-1" }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "workspaces/switch",
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = new Request("http://localhost/api/workspaces/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    const response = await POST(badRequest);

    expect(response.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns 400 when workspaceId is missing or not a string", async () => {
    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns 403 and never sets the cookie when the caller isn't a member of the target workspace", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ workspaceId: "ws-not-mine" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You're not a member of that workspace.",
    });
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("checks membership scoped to both the target workspace and the caller", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-invited", userId: "user-1", role: "member" });

    await POST(jsonRequest({ workspaceId: "ws-invited" }));

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-invited", userId: "user-1" },
    });
  });

  it("sets the active workspace cookie (httpOnly, lax, path /, 1y) and returns 200 on success", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-invited", userId: "user-1", role: "member" });

    const response = await POST(jsonRequest({ workspaceId: "ws-invited" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, workspaceId: "ws-invited" });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "vs_active_workspace",
      "ws-invited",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      }),
    );
  });
});
