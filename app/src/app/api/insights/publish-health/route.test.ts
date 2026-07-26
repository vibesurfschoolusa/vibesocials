import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: { postJobResult: { findMany: findManyMock } },
}));

import { GET, PUBLISH_HEALTH_WINDOW_DAYS } from "./route";

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/insights/publish-health", () => {
  it("401s when unauthenticated and never queries", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("scopes the read to the active workspace and to finished results only", async () => {
    await GET();

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.postJob).toEqual({ workspaceId: "ws-1" });
    expect(args.where.status).toEqual({ in: ["success", "failed"] });
    expect(args.where.updatedAt.gte).toBeInstanceOf(Date);
    // SEC-1: never select errorCode / socialConnectionId / externalPostId.
    expect(args.select).toEqual({ platform: true, status: true, updatedAt: true });
  });

  it("summarizes rows per platform and reports the window", async () => {
    const recent = new Date();
    findManyMock.mockResolvedValue([
      { platform: "youtube", status: "success", updatedAt: recent },
      { platform: "youtube", status: "failed", updatedAt: recent },
      { platform: "tiktok", status: "success", updatedAt: recent },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.windowDays).toBe(PUBLISH_HEALTH_WINDOW_DAYS);
    expect(body.overall).toEqual({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      successRate: 67,
    });
    expect(body.platforms).toHaveLength(2);
    expect(body.platforms[0]).toEqual({
      platform: "youtube",
      attempted: 2,
      succeeded: 1,
      failed: 1,
      successRate: 50,
    });
  });

  it("returns an empty summary for a workspace that has never published", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.platforms).toEqual([]);
    expect(body.overall.successRate).toBeNull();
  });
});
