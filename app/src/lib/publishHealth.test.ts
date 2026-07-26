import { describe, expect, it } from "vitest";

import { summarizePublishHealth } from "./publishHealth";

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
