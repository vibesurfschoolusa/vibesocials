import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/active/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` at module scope, so both must be mocked before route.ts
// is imported below. `WorkspaceForbiddenError` is kept REAL via importActual.
const { deleteManyMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  deleteManyMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { deleteMany: deleteManyMock },
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
import { DELETE } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

function ctx(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

beforeEach(() => {
  deleteManyMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
  deleteManyMock.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/workspaces/members/[userId]", () => {
  it("returns 401 when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(401);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a member (owner-gated)", async () => {
    getWorkspaceContextMock.mockRejectedValue(new WorkspaceForbiddenError());

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the owner tries to remove themselves", async () => {
    const response = await DELETE(new Request("http://localhost"), ctx("user-1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer ownership before removing yourself.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the target isn't a member of the active workspace", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(new Request("http://localhost"), ctx("user-ghost"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("deletes the membership scoped to the active workspace and target user, returns 200 { ok: true }", async () => {
    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2" },
    });
  });
});
