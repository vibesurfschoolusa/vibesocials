import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/members/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` at module scope, so both must be mocked before the
// route is imported below.
const { findManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workspaceMember: { findMany: findManyMock } },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { GET } from "./route";

const MEMBER_CONTEXT = {
  user: { id: "user-2", email: "member@example.com", name: "Member Two" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
  memberCount: 2,
};

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
});

describe("GET /api/workspaces/members/roster", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns names-only roster for a member, ordered by join date", async () => {
    findManyMock.mockResolvedValue([
      { role: "owner", user: { name: "Owner", email: "owner@example.com" } },
      { role: "member", user: { name: null, email: "pat.doe@example.com" } },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      members: [
        { name: "Owner", role: "owner" },
        { name: "pat.doe", role: "member" }, // email local-part fallback (posts/route.ts rule)
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("never leaks emails or user ids (SEC-1)", async () => {
    findManyMock.mockResolvedValue([
      { role: "member", user: { name: null, email: "secret.person@example.com" } },
    ]);
    const response = await GET();
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain("@example.com");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("userId");
  });

  it("works for owners too (any-member endpoint)", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...MEMBER_CONTEXT, role: "owner" });
    findManyMock.mockResolvedValue([]);
    const response = await GET();
    expect(response.status).toBe(200);
  });
});
