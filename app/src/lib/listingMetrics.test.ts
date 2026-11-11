import { describe, expect, it } from "vitest";

import { describeListingChange, summarizeListingMetrics, type ListingMetricRow } from "./listingMetrics";

function row(day: string, over: Partial<ListingMetricRow> = {}): ListingMetricRow {
  return {
    day: new Date(`${day}T00:00:00.000Z`),
    searchViews: 0,
    mapsViews: 0,
    calls: 0,
    directionRequests: 0,
    websiteClicks: 0,
    ...over,
  };
}

/** `count` consecutive days ending on `end`, each with the same numbers. */
function days(end: string, count: number, over: Partial<ListingMetricRow> = {}): ListingMetricRow[] {
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) =>
    row(new Date(endMs - i * 86_400_000).toISOString().slice(0, 10), over),
  );
}

describe("summarizeListingMetrics", () => {
  it("is empty with no rows", () => {
    expect(summarizeListingMetrics([], 28)).toEqual({ endDay: null, current: null, previous: null });
  });

  it("anchors the current window on the newest stored day, not today", () => {
    const rows = days("2026-11-07", 28, { searchViews: 2, mapsViews: 3, calls: 1, directionRequests: 1, websiteClicks: 1 });
    const summary = summarizeListingMetrics(rows, 28);
    expect(summary.endDay).toBe("2026-11-07");
    expect(summary.current).toEqual({ views: 140, calls: 28, directionRequests: 28, websiteClicks: 28 });
  });

  it("gives no previous totals when nothing is stored before the current window", () => {
    expect(summarizeListingMetrics(days("2026-11-07", 10, { calls: 1 }), 28).previous).toBeNull();
  });

  // Current window 2026-10-11 .. 2026-11-07; previous 2026-09-13 .. 2026-10-10.
  it("sums the 28 days before the current window when the history covers all of them", () => {
    const rows = [...days("2026-11-07", 28, { calls: 2 }), ...days("2026-10-10", 28, { calls: 1, websiteClicks: 1 })];
    const summary = summarizeListingMetrics(rows, 28);
    expect(summary.current?.calls).toBe(56);
    expect(summary.previous).toEqual({ views: 0, calls: 28, directionRequests: 0, websiteClicks: 28 });
  });

  it("gives no previous totals when the history starts inside the previous window", () => {
    const rows = [...days("2026-11-07", 28, { calls: 2 }), ...days("2026-10-10", 20, { calls: 1 })];
    expect(summarizeListingMetrics(rows, 28).previous).toBeNull();
  });

  it("never lets rows older than the previous window switch the comparison on, nor count", () => {
    const rows = [
      ...days("2026-11-07", 28, { calls: 2 }),
      ...days("2026-10-10", 5, { calls: 1 }),
      row("2026-09-12", { calls: 100 }),
      row("2026-08-01", { calls: 100 }),
    ];
    expect(summarizeListingMetrics(rows, 28).previous).toBeNull();
  });

  it("counts days missing inside a covered window as zero", () => {
    const rows = [
      row("2026-11-07", { calls: 3 }),
      row("2026-10-20", { calls: 2 }),
      row("2026-10-05", { calls: 4 }),
      row("2026-09-13"),
    ];
    const summary = summarizeListingMetrics(rows, 28);
    expect(summary.current?.calls).toBe(5);
    expect(summary.previous?.calls).toBe(4);
  });

  it("ends the current window on the newest day with a number above zero; later zero days are not counted yet", () => {
    const rows = [
      row("2026-11-09"),
      row("2026-11-08"),
      ...days("2026-11-07", 56, { calls: 1 }),
    ];
    const summary = summarizeListingMetrics(rows, 28);
    expect(summary.endDay).toBe("2026-11-07");
    expect(summary.current?.calls).toBe(28);
    // The previous window moves back with it: 2026-09-13 .. 2026-10-10, fully covered.
    expect(summary.previous?.calls).toBe(28);
  });

  it("ends on the newest stored day when every stored day is zero", () => {
    const summary = summarizeListingMetrics([row("2026-11-09"), row("2026-11-01")], 28);
    expect(summary.endDay).toBe("2026-11-09");
    expect(summary.current).toEqual({ views: 0, calls: 0, directionRequests: 0, websiteClicks: 0 });
  });

  it("accepts days as YYYY-MM-DD strings, as JSON brings them", () => {
    const summary = summarizeListingMetrics(
      [{ ...row("2026-11-07", { mapsViews: 4 }), day: "2026-11-07" as unknown as Date }],
      28,
    );
    expect(summary.current?.views).toBe(4);
  });
});

describe("describeListingChange", () => {
  it("says up or down by how much", () => {
    expect(describeListingChange(30, 18)).toBe("up 12");
    expect(describeListingChange(5, 8)).toBe("down 3");
    expect(describeListingChange(5, 5)).toBe("no change");
  });

  it("says nothing without earlier data", () => {
    expect(describeListingChange(5, null)).toBeNull();
  });
});
