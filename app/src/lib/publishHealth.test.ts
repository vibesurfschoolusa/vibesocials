import { describe, expect, it } from "vitest";

import { summarizePublishHealth, summarizePublishHealthCounts } from "./publishHealth";

const NOW = new Date("2026-07-26T12:00:00Z");
const inWindow = "2026-07-20T12:00:00Z";
const outOfWindow = "2026-05-01T12:00:00Z";

describe("summarizePublishHealth", () => {
  it("counts successes and failures per platform inside the window", () => {
    const summary = summarizePublishHealth(
      [
        { platform: "youtube", status: "success", finishedAt: inWindow },
        { platform: "youtube", status: "failed", finishedAt: inWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
        { platform: "tiktok", status: "failed", finishedAt: inWindow },
      ],
      NOW,
      30,
    );

    expect(summary.platforms).toEqual([
      { platform: "youtube", attempted: 3, succeeded: 2, failed: 1, successRate: 67 },
      { platform: "tiktok", attempted: 1, succeeded: 0, failed: 1, successRate: 0 },
    ]);
    // 2 of 4 succeeded (youtube 2/3, tiktok 0/1).
    expect(summary.overall).toEqual({ attempted: 4, succeeded: 2, failed: 2, successRate: 50 });
  });

  it("ignores results outside the window", () => {
    const summary = summarizePublishHealth(
      [
        { platform: "youtube", status: "success", finishedAt: outOfWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
      ],
      NOW,
      30,
    );
    expect(summary.overall.attempted).toBe(1);
  });

  it("ignores results that haven't finished (pending)", () => {
    const summary = summarizePublishHealth(
      [
        { platform: "youtube", status: "pending", finishedAt: inWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
      ],
      NOW,
      30,
    );
    expect(summary.overall).toEqual({ attempted: 1, succeeded: 1, failed: 0, successRate: 100 });
  });

  it("orders platforms by attempts, busiest first", () => {
    const summary = summarizePublishHealth(
      [
        { platform: "tiktok", status: "success", finishedAt: inWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
      ],
      NOW,
      30,
    );
    expect(summary.platforms.map((p) => p.platform)).toEqual(["youtube", "tiktok"]);
  });

  it("reports an empty summary when nothing has run", () => {
    const summary = summarizePublishHealth([], NOW, 30);
    expect(summary.platforms).toEqual([]);
    expect(summary.overall).toEqual({ attempted: 0, succeeded: 0, failed: 0, successRate: null });
  });

  it("rounds the rate to a whole percent and never reports a misleading 100%", () => {
    // 2 of 3 = 66.67 -> 67; 1 of 3 = 33.33 -> 33. A rate is only 100 when
    // nothing failed.
    const summary = summarizePublishHealth(
      [
        { platform: "x", status: "success", finishedAt: inWindow },
        { platform: "x", status: "success", finishedAt: inWindow },
        { platform: "x", status: "failed", finishedAt: inWindow },
      ],
      NOW,
      30,
    );
    expect(summary.overall.successRate).toBe(67);
  });

  it("accepts Date objects as well as ISO strings", () => {
    const summary = summarizePublishHealth(
      [{ platform: "youtube", status: "success", finishedAt: new Date(inWindow) }],
      NOW,
      30,
    );
    expect(summary.overall.attempted).toBe(1);
  });
});

describe("summarizePublishHealthCounts", () => {
  it("gives the same summary as summarizePublishHealth for an equivalent row set", () => {
    const fromRows = summarizePublishHealth(
      [
        { platform: "youtube", status: "success", finishedAt: inWindow },
        { platform: "youtube", status: "success", finishedAt: inWindow },
        { platform: "youtube", status: "failed", finishedAt: inWindow },
        { platform: "tiktok", status: "failed", finishedAt: inWindow },
        { platform: "x", status: "success", finishedAt: inWindow },
      ],
      NOW,
      30,
    );
    const fromCounts = summarizePublishHealthCounts([
      { platform: "youtube", status: "success", count: 2 },
      { platform: "youtube", status: "failed", count: 1 },
      { platform: "tiktok", status: "failed", count: 1 },
      { platform: "x", status: "success", count: 1 },
    ]);

    expect(fromCounts).toEqual(fromRows);
  });

  it("computes the rate from grouped counts", () => {
    const summary = summarizePublishHealthCounts([
      { platform: "x", status: "success", count: 3 },
      { platform: "x", status: "failed", count: 1 },
    ]);

    expect(summary.platforms).toEqual([
      { platform: "x", attempted: 4, succeeded: 3, failed: 1, successRate: 75 },
    ]);
    expect(summary.overall).toEqual({ attempted: 4, succeeded: 3, failed: 1, successRate: 75 });
  });

  it("ignores statuses that are not finished", () => {
    const summary = summarizePublishHealthCounts([
      { platform: "x", status: "pending", count: 5 },
      { platform: "x", status: "success", count: 1 },
    ]);

    expect(summary.overall).toEqual({ attempted: 1, succeeded: 1, failed: 0, successRate: 100 });
  });

  it("adds up repeated (platform, status) rows", () => {
    const summary = summarizePublishHealthCounts([
      { platform: "x", status: "success", count: 2 },
      { platform: "x", status: "success", count: 3 },
    ]);

    expect(summary.platforms).toEqual([
      { platform: "x", attempted: 5, succeeded: 5, failed: 0, successRate: 100 },
    ]);
  });

  it("skips empty groups and reports an empty summary when nothing finished", () => {
    expect(summarizePublishHealthCounts([])).toEqual({
      platforms: [],
      overall: { attempted: 0, succeeded: 0, failed: 0, successRate: null },
    });
    expect(
      summarizePublishHealthCounts([{ platform: "x", status: "success", count: 0 }]).platforms,
    ).toEqual([]);
  });

  it("orders platforms by attempts, busiest first", () => {
    const summary = summarizePublishHealthCounts([
      { platform: "tiktok", status: "success", count: 1 },
      { platform: "youtube", status: "success", count: 4 },
    ]);

    expect(summary.platforms.map((p) => p.platform)).toEqual(["youtube", "tiktok"]);
  });
});
