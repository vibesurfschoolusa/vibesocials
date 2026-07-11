import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { findMany: findManyMock },
  },
}));

import {
  METRICS_SYNC_BATCH,
  selectYouTubeMetricEligibleResults,
} from "@/server/jobs/metricsScanner";

beforeEach(() => {
  findManyMock.mockReset();
});

describe("selectYouTubeMetricEligibleResults", () => {
  it("queries only successful YouTube results with a non-null externalPostId, bounded and newest-first", async () => {
    findManyMock.mockResolvedValue([]);

    await selectYouTubeMetricEligibleResults();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      platform: "youtube",
      status: "success",
      externalPostId: { not: null },
    });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.take).toBe(METRICS_SYNC_BATCH);
    // Pulls userId off the parent job (PostJobResult has no userId column).
    expect(arg.select).toMatchObject({
      id: true,
      externalPostId: true,
      postJob: { select: { userId: true } },
    });
  });

  it("honors a custom take (bounded batch)", async () => {
    findManyMock.mockResolvedValue([]);
    await selectYouTubeMetricEligibleResults(5);
    expect(findManyMock.mock.calls[0][0].take).toBe(5);
  });

  it("flattens rows into the denormalized eligible shape (resultId/userId/platform/externalPostId)", async () => {
    findManyMock.mockResolvedValue([
      { id: "r1", externalPostId: "vidA", postJob: { userId: "user-1" } },
      { id: "r2", externalPostId: "vidB", postJob: { userId: "user-2" } },
    ]);

    const result = await selectYouTubeMetricEligibleResults();

    expect(result).toEqual([
      { resultId: "r1", userId: "user-1", platform: "youtube", externalPostId: "vidA" },
      { resultId: "r2", userId: "user-2", platform: "youtube", externalPostId: "vidB" },
    ]);
  });

  it("defensively skips any row whose externalPostId is null despite the WHERE", async () => {
    findManyMock.mockResolvedValue([
      { id: "r1", externalPostId: null, postJob: { userId: "user-1" } },
      { id: "r2", externalPostId: "vidB", postJob: { userId: "user-1" } },
    ]);

    const result = await selectYouTubeMetricEligibleResults();

    expect(result).toEqual([
      { resultId: "r2", userId: "user-1", platform: "youtube", externalPostId: "vidB" },
    ]);
  });
});
