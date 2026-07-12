import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/active/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` (the shared `requireOwnerContext` owner gate — review
// fix round 1, Minor 1; its 401/403 mapping is unit-tested in
// src/lib/workspace.test.ts) at module scope, so both must be mocked before
// route.ts is imported below.
const { findFirstMock, deleteManyMock, requireOwnerContextMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  deleteManyMock: vi.fn(),
  requireOwnerContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findFirst: findFirstMock, deleteMany: deleteManyMock },
  },
}));

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

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
  findFirstMock.mockReset();
  deleteManyMock.mockReset();
  requireOwnerContextMock.mockReset();
  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
  findFirstMock.mockResolvedValue({ role: "member" });
  deleteManyMock.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/workspaces/members/[userId]", () => {
  it("returns the gate's 401 response as-is when unauthenticated", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(401);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is for a member (owner-gated)", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

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
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never deletes when the target membership is an owner (review fix round 1 — future-proofs multi-owner states)", async () => {
    findFirstMock.mockResolvedValue({ role: "owner" });

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Owners can't be removed.",
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the target isn't a member of the active workspace", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost"), ctx("user-ghost"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-ghost" },
      select: { role: true },
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes via an atomic role-guarded delete scoped to the active workspace and target user, returns 200 { ok: true }", async () => {
    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // The role guard is repeated IN the delete's where clause so a
    // concurrent promotion between the read and the delete can't remove an
    // owner (conditional-mutation pattern, same as the posts cancel route).
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-2", role: { not: "owner" } },
    });
  });

  it("returns 404 when the atomic delete matches nothing (membership raced away)", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(new Request("http://localhost"), ctx("user-2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
