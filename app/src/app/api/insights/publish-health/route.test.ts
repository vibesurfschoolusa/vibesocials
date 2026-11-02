import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, groupByMock, findManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  groupByMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: { postJobResult: { groupBy: groupByMock, findMany: findManyMock } },
}));

import { GET, PUBLISH_HEALTH_WINDOW_DAYS } from "./route";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  groupByMock.mockReset();
  findManyMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  groupByMock.mockResolvedValue([]);
});

describe("GET /api/insights/publish-health", () => {
  it("401s when unauthenticated and never queries", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(groupByMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // 2026-11-01 scale audit (db M5, web W16): one grouped COUNT keyed on the
  // denormalized PostJobResult.workspaceId (index [workspaceId, updatedAt]). No
  // join through PostJob, and no row cap: the counts are exact for any tenant.
  it("counts finished results of the active workspace in one grouped query", async () => {
    const before = Date.now();
    await GET();
    const after = Date.now();

    expect(groupByMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).not.toHaveBeenCalled();

    const args = groupByMock.mock.calls[0][0];
    expect(args).toEqual({
      by: ["platform", "status"],
      where: {
        workspaceId: "ws-1",
        status: { in: ["success", "failed"] },
        updatedAt: { gte: expect.any(Date) },
      },
      _count: { _all: true },
    });
    // No relation filter, no row cap.
    expect(args.where).not.toHaveProperty("postJob");
    expect(args).not.toHaveProperty("take");

    // The window is the last PUBLISH_HEALTH_WINDOW_DAYS days, read on updatedAt
    // (the moment a result finished).
    const since = (args.where.updatedAt.gte as Date).getTime();
    expect(since).toBeGreaterThanOrEqual(before - PUBLISH_HEALTH_WINDOW_DAYS * DAY_MS);
    expect(since).toBeLessThanOrEqual(after - PUBLISH_HEALTH_WINDOW_DAYS * DAY_MS);
  });

  // SEC-1: only platform and status are grouped, so errorCode,
  // socialConnectionId and externalPostId can never reach the response.
  it("groups on platform and status only", async () => {
    await GET();

    expect(groupByMock.mock.calls[0][0].by).toEqual(["platform", "status"]);
    expect(groupByMock.mock.calls[0][0]).not.toHaveProperty("select");
  });

  it("turns the grouped counts into per-platform rates and reports the window", async () => {
    groupByMock.mockResolvedValue([
      { platform: "x", status: "success", _count: { _all: 3 } },
      { platform: "x", status: "failed", _count: { _all: 1 } },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.windowDays).toBe(PUBLISH_HEALTH_WINDOW_DAYS);
    expect(body.platforms).toEqual([
      { platform: "x", attempted: 4, succeeded: 3, failed: 1, successRate: 75 },
    ]);
    expect(body.overall).toEqual({ attempted: 4, succeeded: 3, failed: 1, successRate: 75 });
  });

  it("summarizes several platforms, busiest first", async () => {
    groupByMock.mockResolvedValue([
      { platform: "tiktok", status: "success", _count: { _all: 1 } },
      { platform: "youtube", status: "success", _count: { _all: 1 } },
      { platform: "youtube", status: "failed", _count: { _all: 1 } },
    ]);

    const body = await (await GET()).json();

    expect(body.overall).toEqual({ attempted: 3, succeeded: 2, failed: 1, successRate: 67 });
    expect(body.platforms.map((p: { platform: string }) => p.platform)).toEqual([
      "youtube",
      "tiktok",
    ]);
    expect(body.platforms[0]).toEqual({
      platform: "youtube",
      attempted: 2,
      succeeded: 1,
      failed: 1,
      successRate: 50,
    });
  });

  // Counts are exact now: a heavy tenant is no longer cut off at 2,000 rows.
  it("reports exact counts above the old 2,000-row cap", async () => {
    groupByMock.mockResolvedValue([
      { platform: "x", status: "success", _count: { _all: 9000 } },
      { platform: "x", status: "failed", _count: { _all: 1000 } },
    ]);

    const body = await (await GET()).json();

    expect(body.overall).toEqual({ attempted: 10000, succeeded: 9000, failed: 1000, successRate: 90 });
  });

  // 2026-11-01 audit, Task 5: results outlive a removed connection (FK is
  // SET NULL), and health must keep counting them. The query is therefore
  // keyed on the result's workspace and never on the connection relation.
  it("does not filter on the connection, so results of a removed connection still count", async () => {
    await GET();

    const args = groupByMock.mock.calls[0][0];
    expect(Object.keys(args.where).sort()).toEqual(["status", "updatedAt", "workspaceId"]);
    expect(JSON.stringify(args.where)).not.toContain("socialConnection");
  });

  it("returns an empty summary for a workspace that has never published", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.platforms).toEqual([]);
    expect(body.overall.successRate).toBeNull();
  });
});
