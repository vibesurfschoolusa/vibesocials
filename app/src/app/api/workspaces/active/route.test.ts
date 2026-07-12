import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/switch/route.test.ts). route.ts imports `@/lib/db` and
// `@/lib/workspace` (the shared `requireOwnerContext` owner gate — review
// fix round 1, Minor 1) at module scope, so both must be mocked before
// route.ts is imported below. The gate's own 401/403 mapping is unit-tested
// in src/lib/workspace.test.ts; here it's mocked to either the owner
// context or a ready-made error response.
const { updateMock, requireOwnerContextMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  requireOwnerContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { update: updateMock },
  },
}));

vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: requireOwnerContextMock,
}));

import { PATCH } from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Old name", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 1,
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/workspaces/active", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updateMock.mockReset();
  requireOwnerContextMock.mockReset();
  requireOwnerContextMock.mockResolvedValue(OWNER_CONTEXT);
});

describe("PATCH /api/workspaces/active", () => {
  it("returns the gate's 401 response as-is when unauthenticated", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await PATCH(jsonRequest({ name: "New name" }));

    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns the gate's 403 response as-is when a member (not owner) calls it", async () => {
    requireOwnerContextMock.mockResolvedValue(
      NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }),
    );

    const response = await PATCH(jsonRequest({ name: "New name" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the workspace owner can do that.",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = new Request("http://localhost/api/workspaces/active", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    const response = await PATCH(badRequest);

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing or not a string", async () => {
    const response = await PATCH(jsonRequest({}));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the trimmed name is empty", async () => {
    const response = await PATCH(jsonRequest({ name: "   " }));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the trimmed name exceeds 60 characters", async () => {
    const response = await PATCH(jsonRequest({ name: "a".repeat(61) }));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts a name at exactly 60 characters", async () => {
    const name = "a".repeat(60);
    updateMock.mockResolvedValue({ id: "ws-1", name });

    const response = await PATCH(jsonRequest({ name }));

    expect(response.status).toBe(200);
  });

  it("accepts a name at exactly 1 character", async () => {
    updateMock.mockResolvedValue({ id: "ws-1", name: "x" });

    const response = await PATCH(jsonRequest({ name: "x" }));

    expect(response.status).toBe(200);
  });

  it("trims the name before validating and persisting, and updates the ACTIVE workspace", async () => {
    updateMock.mockResolvedValue({ id: "ws-1", name: "Trimmed name" });

    const response = await PATCH(jsonRequest({ name: "  Trimmed name  " }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ id: "ws-1", name: "Trimmed name" });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { name: "Trimmed name" },
      select: { id: true, name: true },
    });
  });
});
