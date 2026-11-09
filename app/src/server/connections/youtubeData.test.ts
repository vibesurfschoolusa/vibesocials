import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteManyMock } = vi.hoisted(() => ({ deleteManyMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { postMetric: { deleteMany: deleteManyMock } },
}));

import { purgeStaleYouTubeMetrics, YOUTUBE_METRICS_MAX_AGE_MS } from "./youtubeData";

beforeEach(() => {
  deleteManyMock.mockReset();
  deleteManyMock.mockResolvedValue({ count: 3 });
});

// YouTube Developer Policies III.E.4: stored statistics must be refreshed or
// deleted within 30 days.
describe("purgeStaleYouTubeMetrics", () => {
  it("deletes YouTube statistics not refreshed in 30 days, and only those", async () => {
    const now = new Date("2026-11-09T12:00:00.000Z");

    const purged = await purgeStaleYouTubeMetrics(now);

    expect(purged).toBe(3);
    expect(YOUTUBE_METRICS_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { platform: "youtube", fetchedAt: { lt: new Date("2026-10-10T12:00:00.000Z") } },
    });
  });
});
