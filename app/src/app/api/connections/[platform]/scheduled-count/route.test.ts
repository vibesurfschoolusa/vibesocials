import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// R5 pages M1 (review): the Disconnect dialog's count of scheduled posts that
// chose the platform, counted on the server in one query.
const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({ prisma: { postJob: { findMany: findManyMock } } }));

import { GET } from "./route";

function call(platform: string, workspaceId?: string) {
  const query = workspaceId === undefined ? "" : `?workspaceId=${workspaceId}`;
  return GET(new NextRequest(`http://localhost/api/connections/${platform}/scheduled-count${query}`), {
    params: Promise.resolve({ platform }),
  });
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue({ workspace: { id: "ws-1" }, role: "owner" });
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/connections/[platform]/scheduled-count", () => {
  it("answers 401 signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await call("instagram", "ws-1")).status).toBe(401);
  });

  it("refuses another workspace's tab and a missing workspace id without reading posts", async () => {
    expect((await call("instagram", "ws-2")).status).toBe(409);
    expect((await call("instagram")).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown platform", async () => {
    expect((await call("myspace", "ws-1")).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("counts the workspace's scheduled posts whose chosen platforms name it, in one query", async () => {
    findManyMock.mockResolvedValue([
      { id: "a", storyOfPostJobId: null },
      { id: "b", storyOfPostJobId: null },
    ]);
    const response = await call("instagram", "ws-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 2 });
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      workspaceId: "ws-1",
      status: "scheduled",
      publishMetadata: { path: ["targetPlatforms"], array_contains: ["instagram"] },
    });
  });

  it("counts a Feed and Story post once", async () => {
    findManyMock.mockResolvedValue([
      { id: "feed", storyOfPostJobId: null },
      { id: "story", storyOfPostJobId: "feed" },
      { id: "story-only-half", storyOfPostJobId: "other-feed" },
    ]);
    await expect((await call("instagram", "ws-1")).json()).resolves.toEqual({ count: 2 });
  });

  it("answers 500 with a sentence when the count fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findManyMock.mockRejectedValue(new Error("db down"));
    const response = await call("instagram", "ws-1");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("couldn't count");
  });
});
