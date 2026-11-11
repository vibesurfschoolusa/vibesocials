import { describe, expect, it } from "vitest";

import {
  REPORT_CAPTION_MAX,
  REPORT_MONTH_INVALID_MESSAGE,
  REPORT_POST_MAX,
  defaultReportMonth,
  failedLine,
  monthBounds,
  monthLabel,
  numberLine,
  parseReportMonth,
  publicMonthlyReport,
  reportCaption,
  reportMonths,
  showingLine,
  summarizeListingMonth,
  summarizePostNumbers,
  type ReportPost,
} from "./monthlyReport";

const NOW = new Date("2026-11-10T12:00:00Z");

describe("monthBounds", () => {
  it("is the calendar month in UTC, end exclusive", () => {
    const { start, end } = monthBounds("2026-10");
    expect(start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("rolls over the year", () => {
    const { start, end } = monthBounds("2025-12");
    expect(start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("reportMonths and defaultReportMonth", () => {
  it("lists the month in progress and the 12 full months before it, newest first", () => {
    const months = reportMonths(NOW);
    expect(months).toHaveLength(13);
    expect(months[0]).toBe("2026-11");
    expect(months[1]).toBe("2026-10");
    expect(months[12]).toBe("2025-11");
  });

  it("defaults to the last full month", () => {
    expect(defaultReportMonth(NOW)).toBe("2026-10");
    expect(defaultReportMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12");
  });

  it("counts the month in UTC: late on the 31st in UTC is still that month", () => {
    expect(reportMonths(new Date("2026-10-31T23:59:59Z"))[0]).toBe("2026-10");
    expect(reportMonths(new Date("2026-11-01T00:00:00Z"))[0]).toBe("2026-11");
  });
});

describe("parseReportMonth", () => {
  it("gives the last full month when none is asked for", () => {
    expect(parseReportMonth(undefined, NOW)).toEqual({ ok: true, month: "2026-10", inProgress: false });
    expect(parseReportMonth("", NOW)).toEqual({ ok: true, month: "2026-10", inProgress: false });
  });

  it("accepts the month in progress and says so", () => {
    expect(parseReportMonth("2026-11", NOW)).toEqual({ ok: true, month: "2026-11", inProgress: true });
  });

  it("accepts 12 months back and refuses 13", () => {
    expect(parseReportMonth("2025-11", NOW)).toEqual({ ok: true, month: "2025-11", inProgress: false });
    expect(parseReportMonth("2025-10", NOW)).toEqual({ ok: false, error: REPORT_MONTH_INVALID_MESSAGE });
  });

  it("refuses a month in the future", () => {
    expect(parseReportMonth("2026-12", NOW)).toEqual({ ok: false, error: REPORT_MONTH_INVALID_MESSAGE });
  });

  it("refuses malformed months", () => {
    for (const value of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "abc", " 2026-10", ["2026-10"], 202610]) {
      expect(parseReportMonth(value, NOW), String(value)).toEqual({
        ok: false,
        error: REPORT_MONTH_INVALID_MESSAGE,
      });
    }
  });
});

describe("monthLabel", () => {
  it("names the month in English", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });
});

describe("reportCaption", () => {
  it("keeps a short caption whole and cuts a long one to 200 characters", () => {
    expect(reportCaption("Dawn patrol")).toBe("Dawn patrol");
    const long = "a".repeat(250);
    const cut = reportCaption(long);
    expect(Array.from(cut)).toHaveLength(REPORT_CAPTION_MAX);
    expect(cut.endsWith("…")).toBe(true);
  });
});

function post(numbers: ReportPost["platforms"][number]["numbers"][], overrides: Partial<ReportPost> = {}): ReportPost {
  return {
    publishedAt: "2026-10-12T10:00:00.000Z",
    caption: "x",
    media: null,
    mediaCount: 1,
    platforms: numbers.map((n) => ({ platform: "Instagram", story: false, url: null, numbers: n })),
    ...overrides,
  };
}

describe("summarizePostNumbers", () => {
  it("sums each number over the posts that have it, and counts those posts", () => {
    const totals = summarizePostNumbers([
      post([{ likes: 10, views: 100 }]),
      post([{ likes: 5 }, { likes: 2, comments: 1 }]),
      post([{}]),
    ]);
    expect(totals).toEqual([
      { key: "views", label: "Views", sum: 100, posts: 1 },
      { key: "likes", label: "Likes", sum: 17, posts: 2 },
      { key: "comments", label: "Comments", sum: 1, posts: 1 },
    ]);
  });

  it("counts a zero as a number the post has", () => {
    expect(summarizePostNumbers([post([{ shares: 0 }])])).toEqual([
      { key: "shares", label: "Shares", sum: 0, posts: 1 },
    ]);
  });

  it("gives nothing when no post has a number", () => {
    expect(summarizePostNumbers([post([{}]), post([])])).toEqual([]);
  });

  it("writes the line with the count it covers", () => {
    expect(numberLine({ key: "likes", label: "Likes", sum: 312, posts: 18 })).toBe("Likes: 312 across 18 posts");
    expect(numberLine({ key: "likes", label: "Likes", sum: 4, posts: 1 })).toBe("Likes: 4 across 1 post");
  });
});

describe("showingLine (the cap of 200)", () => {
  it("says nothing when every post is shown", () => {
    expect(REPORT_POST_MAX).toBe(200);
    expect(showingLine(200, 200)).toBeNull();
    expect(showingLine(3, 3)).toBeNull();
  });

  it("says how many are shown of how many", () => {
    expect(showingLine(200, 245)).toBe("Showing the 200 most recent of 245.");
  });
});

describe("failedLine", () => {
  it("is a plain count with no detail", () => {
    expect(failedLine({ platform: "Instagram", count: 2 })).toBe("2 posts did not publish on Instagram");
    expect(failedLine({ platform: "X", count: 1 })).toBe("1 post did not publish on X");
  });
});

function day(key: string, n = 1) {
  return {
    day: new Date(`${key}T00:00:00.000Z`),
    searchViews: n,
    mapsViews: n,
    calls: n,
    directionRequests: n,
    websiteClicks: n,
  };
}

function daysOf(month: string, count: number, n = 1) {
  return Array.from({ length: count }, (_, i) => day(`${month}-${String(i + 1).padStart(2, "0")}`, n));
}

describe("summarizeListingMonth", () => {
  it("is null with no stored day in the month", () => {
    expect(summarizeListingMonth([], "2026-10", NOW)).toBeNull();
    // Days of the month before say nothing about this one.
    expect(summarizeListingMonth(daysOf("2026-09", 30), "2026-10", NOW)).toBeNull();
  });

  it("sums the month and states its coverage; a missing day is missing, not zero", () => {
    const rows = [...daysOf("2026-09", 30), ...daysOf("2026-10", 27, 2)];
    const listing = summarizeListingMonth(rows, "2026-10", NOW);
    expect(listing).toEqual({
      daysCovered: 27,
      daysCounted: 31,
      partial: false,
      totals: { views: 108, calls: 54, directionRequests: 54, websiteClicks: 54 },
      // This month is not fully covered: no like-for-like comparison.
      previous: null,
    });
  });

  it("compares with the month before only when both months are fully covered", () => {
    const rows = [...daysOf("2026-09", 30), ...daysOf("2026-10", 31, 2)];
    const listing = summarizeListingMonth(rows, "2026-10", NOW);
    expect(listing?.daysCovered).toBe(31);
    expect(listing?.previous).toEqual({ views: 60, calls: 30, directionRequests: 30, websiteClicks: 30 });
  });

  it("gives no comparison when the month before has a missing day", () => {
    const rows = [...daysOf("2026-09", 29), ...daysOf("2026-10", 31)];
    expect(summarizeListingMonth(rows, "2026-10", NOW)?.previous).toBeNull();
  });

  it("calls the month in progress partial, counts its days so far, and does not compare", () => {
    const rows = [...daysOf("2026-10", 31), ...daysOf("2026-11", 7)];
    const listing = summarizeListingMonth(rows, "2026-11", NOW);
    expect(listing).toMatchObject({ daysCovered: 7, daysCounted: 10, partial: true, previous: null });
  });

  it("ignores rows outside the two months", () => {
    const rows = [day("2026-08-31", 100), ...daysOf("2026-10", 1), day("2026-11-01", 100)];
    expect(summarizeListingMonth(rows, "2026-10", NOW)?.totals).toEqual({
      views: 2,
      calls: 1,
      directionRequests: 1,
      websiteClicks: 1,
    });
  });
});

describe("publicMonthlyReport", () => {
  it("copies the documented fields and nothing else", () => {
    const extra = { workspaceId: "ws-1", token: "secret", id: "post-1", errorMessage: "boom" };
    const report = {
      ...extra,
      month: "2026-10",
      workspaceName: "Surf Co",
      inProgress: false,
      postCount: 1,
      posts: [
        {
          ...extra,
          publishedAt: "2026-10-12T10:00:00.000Z",
          caption: "x",
          media: { ...extra, url: "https://blob.example/a.jpg", mimeType: "image/jpeg" },
          mediaCount: 1,
          platforms: [
            { ...extra, platform: "Instagram", story: false, url: null, numbers: { likes: 2, raw: 5 } },
          ],
        },
      ],
      totals: {
        ...extra,
        resultsByPlatform: [{ ...extra, platform: "Instagram", count: 1 }],
        numbers: [{ ...extra, key: "likes", label: "Likes", sum: 2, posts: 1 }],
      },
      listing: {
        ...extra,
        daysCovered: 1,
        daysCounted: 31,
        partial: false,
        totals: { ...extra, views: 1, calls: 1, directionRequests: 1, websiteClicks: 1 },
        previous: null,
      },
      failed: [{ ...extra, platform: "X", count: 1 }],
    };

    const copy = publicMonthlyReport(report as never);
    const text = JSON.stringify(copy);
    for (const word of ["ws-1", "secret", "post-1", "boom", "raw"]) expect(text).not.toContain(word);
    expect(copy).toEqual({
      month: "2026-10",
      workspaceName: "Surf Co",
      inProgress: false,
      postCount: 1,
      posts: [
        {
          publishedAt: "2026-10-12T10:00:00.000Z",
          caption: "x",
          media: { url: "https://blob.example/a.jpg", mimeType: "image/jpeg" },
          mediaCount: 1,
          platforms: [{ platform: "Instagram", story: false, url: null, numbers: { likes: 2 } }],
        },
      ],
      totals: {
        resultsByPlatform: [{ platform: "Instagram", count: 1 }],
        numbers: [{ key: "likes", label: "Likes", sum: 2, posts: 1 }],
      },
      listing: {
        daysCovered: 1,
        daysCounted: 31,
        partial: false,
        totals: { views: 1, calls: 1, directionRequests: 1, websiteClicks: 1 },
        previous: null,
      },
      failed: [{ platform: "X", count: 1 }],
    });
  });
});
