import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, findFirstMock, checkRateLimitMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  findFirstMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({ prisma: { workspaceMember: { findFirst: findFirstMock } } }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { GET } from "./route";

const ORIGIN = "https://vibesocials.wtf";

function go(query: string) {
  return GET(new Request(`${ORIGIN}/go${query}`));
}

function activeCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  if (!header) return null;
  const match = /vs_active_workspace=([^;]*)/.exec(header);
  return match ? match[1] : null;
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  findFirstMock.mockReset();
  checkRateLimitMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
});

describe("GET /go", () => {
  it("a member: switches to the workspace and opens the page", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-2" });

    const response = await go("?w=ws-2&to=%2Fqueue");

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-2", userId: "user-1" },
      select: { workspaceId: true },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/queue`);
    expect(activeCookie(response)).toBe("ws-2");
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
  });

  it("keeps a section and a query of the page", async () => {
    findFirstMock.mockResolvedValue({ workspaceId: "ws-2" });

    const response = await go(`?w=ws-2&to=${encodeURIComponent("/reports?month=2026-10")}`);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/reports?month=2026-10`);

    const settings = await go(`?w=ws-2&to=${encodeURIComponent("/settings#post-defaults")}`);
    expect(settings.headers.get("location")).toBe(`${ORIGIN}/settings#post-defaults`);
  });

  // R2-client-journey L2: the dashboard says why, naming no workspace.
  it("not a member: the dashboard with the other-workspace notice, and no switch", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await go("?w=ws-other&to=%2Fqueue");

    expect(response.headers.get("location")).toBe(`${ORIGIN}/?notice=other-workspace`);
    expect(activeCookie(response)).toBeNull();
  });

  it("no workspace given: the page, and no switch", async () => {
    const response = await go("?to=%2Fqueue");

    expect(findFirstMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/queue`);
    expect(activeCookie(response)).toBeNull();
  });

  it("signed out: to sign-in, which comes back to this same address", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await go("?w=ws-2&to=%2Fqueue");

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/login`);
    expect(location.searchParams.get("callbackUrl")).toBe("/go?w=ws-2&to=%2Fqueue");
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(activeCookie(response)).toBeNull();
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "/%5Cevil.example", "javascript:alert(1)"])(
    "an address off the site (%s) goes to /",
    async (to) => {
      findFirstMock.mockResolvedValue({ workspaceId: "ws-2" });

      const response = await go(`?w=ws-2&to=${encodeURIComponent(to)}`);

      expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    },
  );

  it("too many requests: opens the dashboard without looking anything up", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await go("?w=ws-2&to=%2Fqueue");

    expect(findFirstMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(activeCookie(response)).toBeNull();
  });
});
