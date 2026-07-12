import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/active/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` at module scope, so both must be mocked before route.ts
// is imported below. `WorkspaceForbiddenError` is kept REAL via importActual.
const { findManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: findManyMock },
  },
}));

vi.mock("@/lib/workspace", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace")>("@/lib/workspace");
  return {
    ...actual,
    getWorkspaceContext: getWorkspaceContextMock,
  };
});

import { WorkspaceForbiddenError } from "@/lib/workspace";
import { GET } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

function makeMembershipRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    role: "member",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    user: { id: "user-2", email: "member@example.com", name: "Member Two" },
    ...overrides,
  };
}

beforeEach(() => {
  findManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
});

describe("GET /api/workspaces/members", () => {
  it("returns 401 when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a member (owner-gated)", async () => {
    getWorkspaceContextMock.mockRejectedValue(new WorkspaceForbiddenError());

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("requests the owner role from getWorkspaceContext", async () => {
    findManyMock.mockResolvedValue([]);

    await GET();

    expect(getWorkspaceContextMock).toHaveBeenCalledWith({ requireRole: "owner" });
  });

  it("returns members scoped to the active workspace, with userId/email/name/role/joinedAt", async () => {
    findManyMock.mockResolvedValue([
      makeMembershipRow({
        role: "owner",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        user: { id: "user-1", email: "owner@example.com", name: "Owner" },
      }),
      makeMembershipRow({
        role: "member",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        user: { id: "user-2", email: "member@example.com", name: null },
      }),
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      members: [
        {
          userId: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "owner",
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          userId: "user-2",
          email: "member@example.com",
          name: null,
          role: "member",
          joinedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
  });
});
