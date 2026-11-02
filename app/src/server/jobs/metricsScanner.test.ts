import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { findMany: findManyMock },
  },
}));

import {
  METRICS_MAX_PAGES_PER_RUN,
  METRICS_MIN_REFRESH_MS,
  METRICS_PAGE_SIZE,
  METRICS_UNITS_PER_RUN,
  YOUTUBE_STATS_IDS_PER_CALL,
  selectYouTubeMetricEligibleResults,
} from "@/server/jobs/metricsScanner";
import * as metricsScanner from "@/server/jobs/metricsScanner";

beforeEach(() => {
  findManyMock.mockReset();
});

describe("metrics sync constants (2026-11-01 scale audit, jobs)", () => {
  it("pages 200 results, at most 10 pages and 300 quota units a run, re-checking a video after 50 minutes", () => {
    expect(METRICS_PAGE_SIZE).toBe(200);
    expect(METRICS_MAX_PAGES_PER_RUN).toBe(10);
    // 300 units x 24 runs = 7,200 of the shared 10,000-unit daily bucket.
    expect(METRICS_UNITS_PER_RUN).toBe(300);
    expect(METRICS_MIN_REFRESH_MS).toBe(3_000_000);
    expect(YOUTUBE_STATS_IDS_PER_CALL).toBe(50);
  });

  it("re-check interval sits below the hourly cron, so start-time jitter cannot skip a cycle (R27)", () => {
    // Run N+1 selects with `now' - METRICS_MIN_REFRESH_MS`. At exactly one hour a
    // result stamped late in run N is eligible only if run N+1 starts as late in
    // its hour as run N did; the slack makes that always true.
    const CRON_INTERVAL_MS = 60 * 60 * 1000;
    expect(METRICS_MIN_REFRESH_MS).toBeLessThan(CRON_INTERVAL_MS);
    // A result stamped 4 minutes after its tick (a slow page) is still eligible
    // when the next run starts 4 minutes EARLY relative to its tick (jitter).
    const MINUTE = 60 * 1000;
    const stampedAt = 4 * MINUTE;
    const nextRunStart = CRON_INTERVAL_MS - 4 * MINUTE;
    expect(stampedAt).toBeLessThan(nextRunStart - METRICS_MIN_REFRESH_MS);
  });

  it("no longer exports the fixed newest-100 batch", () => {
    expect(metricsScanner).not.toHaveProperty("METRICS_SYNC_BATCH");
  });
});

describe("selectYouTubeMetricEligibleResults", () => {
  const NOW = new Date("2026-11-02T13:00:00.000Z");

  it("queries successful YouTube results with a video id that were never checked or not within the last 50 minutes, least-recently-checked first", async () => {
    findManyMock.mockResolvedValue([]);

    await selectYouTubeMetricEligibleResults(undefined, NOW);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      platform: "youtube",
      status: "success",
      externalPostId: { not: null },
      OR: [
        { metricsCheckedAt: null },
        { metricsCheckedAt: { lt: new Date("2026-11-02T12:10:00.000Z") } },
      ],
    });
    expect(arg.orderBy).toEqual([
      { metricsCheckedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "desc" },
    ]);
    expect(arg.take).toBe(METRICS_PAGE_SIZE);
    // Pulls userId/workspaceId off the parent job (PostJobResult has neither
    // column itself). Team Workspaces (Task 5): workspaceId is now needed so
    // the sync can look up the workspace-scoped connection instead of the
    // personal-workspace bridge.
    expect(arg.select).toMatchObject({
      id: true,
      externalPostId: true,
      postJob: { select: { userId: true, workspaceId: true } },
    });
  });

  it("measures the 50 minutes from `now` (METRICS_MIN_REFRESH_MS), defaulting to the current time", async () => {
    findManyMock.mockResolvedValue([]);
    const before = Date.now();

    await selectYouTubeMetricEligibleResults();

    const lt: Date = findManyMock.mock.calls[0][0].where.OR[1].metricsCheckedAt.lt;
    expect(lt.getTime()).toBeGreaterThanOrEqual(before - METRICS_MIN_REFRESH_MS);
    expect(lt.getTime()).toBeLessThanOrEqual(Date.now() - METRICS_MIN_REFRESH_MS);
  });

  it("honors a custom take (bounded batch)", async () => {
    findManyMock.mockResolvedValue([]);
    await selectYouTubeMetricEligibleResults(5, NOW);
    expect(findManyMock.mock.calls[0][0].take).toBe(5);
  });

  it("flattens rows into the denormalized eligible shape (resultId/userId/workspaceId/platform/externalPostId)", async () => {
    findManyMock.mockResolvedValue([
      { id: "r1", externalPostId: "vidA", postJob: { userId: "user-1", workspaceId: "ws-1" } },
      { id: "r2", externalPostId: "vidB", postJob: { userId: "user-2", workspaceId: "ws-2" } },
    ]);

    const result = await selectYouTubeMetricEligibleResults(undefined, NOW);

    expect(result).toEqual([
      { resultId: "r1", userId: "user-1", workspaceId: "ws-1", platform: "youtube", externalPostId: "vidA" },
      { resultId: "r2", userId: "user-2", workspaceId: "ws-2", platform: "youtube", externalPostId: "vidB" },
    ]);
  });

  it("defensively skips any row whose externalPostId is null despite the WHERE", async () => {
    findManyMock.mockResolvedValue([
      { id: "r1", externalPostId: null, postJob: { userId: "user-1", workspaceId: "ws-1" } },
      { id: "r2", externalPostId: "vidB", postJob: { userId: "user-1", workspaceId: "ws-1" } },
    ]);

    const result = await selectYouTubeMetricEligibleResults(undefined, NOW);

    expect(result).toEqual([
      { resultId: "r2", userId: "user-1", workspaceId: "ws-1", platform: "youtube", externalPostId: "vidB" },
    ]);
  });
});
