import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / workspace.test.ts). route.ts imports `@/lib/db`
// and `@/lib/workspace` at module scope, so both must be mocked before
// route.ts is imported below.
const { findManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: findManyMock },
  },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { GET } from "./route";

function makeContext(overrides: Partial<{ userId: string; workspaceId: string }> = {}) {
  const userId = overrides.userId ?? "user-1";
  const workspaceId = overrides.workspaceId ?? "ws-active";
  return {
    user: { id: userId, email: "owner@example.com", name: "Owner" },
    workspace: { id: workspaceId, name: "Active workspace", companyWebsite: null, defaultHashtags: null },
    role: "owner" as const,
    memberCount: 1,
  };
}

function makeMembershipRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workspaceId: "ws-active",
    role: "owner",
    createdAt: new Date("2020-01-01T00:00:00Z"),
    workspace: { id: "ws-active", name: "Active workspace" },
    ...overrides,
  };
}

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
});

describe("GET /api/workspaces", () => {
  it("returns 401 and never queries memberships when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns every membership with role and isActive, scoped to the caller", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext());
    findManyMock.mockResolvedValue([
      makeMembershipRow({
        workspaceId: "ws-personal",
        role: "owner",
        workspace: { id: "ws-personal", name: "Personal workspace" },
      }),
      makeMembershipRow({
        workspaceId: "ws-active",
        role: "member",
        workspace: { id: "ws-active", name: "Active workspace" },
      }),
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      workspaces: [
        { id: "ws-personal", name: "Personal workspace", role: "owner", isActive: false },
        { id: "ws-active", name: "Active workspace", role: "member", isActive: true },
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("marks isActive false for every workspace when none match the context's active id", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeContext({ workspaceId: "ws-active" }));
    findManyMock.mockResolvedValue([
      makeMembershipRow({
        workspaceId: "ws-other",
        workspace: { id: "ws-other", name: "Other" },
      }),
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.workspaces).toEqual([
      { id: "ws-other", name: "Other", role: "owner", isActive: false },
    ]);
  });
});
