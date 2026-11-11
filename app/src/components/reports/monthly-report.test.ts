import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MonthlyReport } from "@/lib/monthlyReport";

import { MonthlyReportView, ReportMonthPicker } from "./monthly-report";

function report(overrides: Partial<MonthlyReport> = {}): MonthlyReport {
  return {
    month: "2026-10",
    workspaceName: "Surf & Co",
    inProgress: false,
    postCount: 2,
    posts: [
      {
        publishedAt: "2026-10-12T10:00:00.000Z",
        caption: "Dawn patrol",
        media: { url: "https://blob.example/a.jpg", mimeType: "image/jpeg" },
        mediaCount: 3,
        platforms: [
          { platform: "Instagram", story: true, url: "https://www.instagram.com/stories/x/1/", numbers: {} },
          { platform: "X", story: false, url: null, numbers: { likes: 4, views: 0 } },
        ],
      },
      {
        publishedAt: "2026-10-02T10:00:00.000Z",
        caption: "Old one",
        media: null,
        mediaCount: 1,
        platforms: [{ platform: "LinkedIn", story: false, url: "https://www.linkedin.com/feed/update/urn:li:share:1", numbers: {} }],
      },
    ],
    totals: {
      resultsByPlatform: [
        { platform: "Instagram", count: 1 },
        { platform: "X", count: 1 },
      ],
      numbers: [{ key: "likes", label: "Likes", sum: 4, posts: 1 }],
    },
    listing: null,
    failed: [],
    ...overrides,
  };
}

function render(r: MonthlyReport, activityHref?: string): string {
  return renderToStaticMarkup(createElement(MonthlyReportView, { report: r, activityHref }));
}

describe("MonthlyReportView", () => {
  it("names the workspace and the month, and says months are UTC", () => {
    const html = render(report());
    expect(html).toContain("Surf &amp; Co");
    expect(html).toContain("October 2026");
    expect(html).toContain("Months are counted in UTC.");
  });

  it("shows each post with its platforms, Stories, links and numbers", () => {
    const html = render(report());
    expect(html).toContain("Dawn patrol");
    expect(html).toContain("Oct 12, 2026");
    expect(html).toContain("3 photos");
    expect(html).toContain("Story");
    expect(html).toContain('href="https://www.instagram.com/stories/x/1/"');
    // The link's address is printed as text beside its label.
    expect(html).toContain(">https://www.instagram.com/stories/x/1/<");
    expect(html).toContain("Likes 4");
    expect(html).toContain("Views 0");
    expect(html).not.toContain("Comments");
  });

  it("shows a neutral placeholder, not an image, for a removed file", () => {
    const html = render(report({ posts: [report().posts[1]] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("File removed");
  });

  it("states totals with the posts each number covers", () => {
    const html = render(report());
    expect(html).toContain("Posts published");
    expect(html).toContain("Likes: 4 across 1 post");
  });

  it("says when only the 200 most recent are shown", () => {
    expect(render(report({ postCount: 245 }))).toContain("Showing the 2 most recent of 245.");
    expect(render(report())).not.toContain("Showing the");
  });

  it("leaves the listing out when there is none", () => {
    expect(render(report())).not.toContain("Google listing");
  });

  it("states the listing's coverage and gives the change only with the month before", () => {
    const listing = {
      daysCovered: 27,
      daysCounted: 31,
      partial: false,
      totals: { views: 120, calls: 5, directionRequests: 7, websiteClicks: 9 },
      previous: null,
    };
    const without = render(report({ listing }));
    expect(without).toContain("Google listing");
    expect(without).toContain("Numbers for 27 of 31 days");
    expect(without).not.toContain(" up ");

    const withPrevious = render(
      report({
        listing: { ...listing, daysCovered: 31, previous: { views: 100, calls: 5, directionRequests: 9, websiteClicks: 9 } },
      }),
    );
    expect(withPrevious).toContain("up 20");
    expect(withPrevious).toContain("down 2");
    expect(withPrevious).toContain("no change");
  });

  it("says the month in progress is partial", () => {
    const html = render(
      report({
        inProgress: true,
        listing: {
          daysCovered: 5,
          daysCounted: 10,
          partial: true,
          totals: { views: 1, calls: 1, directionRequests: 1, websiteClicks: 1 },
          previous: null,
        },
      }),
    );
    expect(html).toContain("This month is not over yet");
  });

  it("links the failures to Activity on the workspace's page and not on the client's", () => {
    const failed = [{ platform: "Instagram", count: 2 }];
    const own = render(report({ failed }), "/activity");
    expect(own).toContain("2 posts did not publish on Instagram");
    expect(own).toContain('href="/activity"');

    const client = render(report({ failed }));
    expect(client).toContain("2 posts did not publish on Instagram");
    expect(client).not.toContain("/activity");
  });

  it("carries a print stylesheet: no navigation or controls, posts kept whole, dark on white", () => {
    const html = render(report());
    expect(html).toContain("@media print");
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("[data-report-noprint]");
    expect(html).toContain("aside");
    // The sheet hides header and nav elements, so the report itself uses neither.
    expect(html).not.toMatch(/<(header|nav|aside)[\s>]/);
  });
});

describe("ReportMonthPicker", () => {
  it("lists the months by name, selects the chosen one, and is left out of print", () => {
    const html = renderToStaticMarkup(
      createElement(ReportMonthPicker, { months: ["2026-11", "2026-10", "2026-09"], selected: "2026-10" }),
    );
    expect(html).toContain('name="month"');
    expect(html).toContain("November 2026 (so far)");
    expect(html).toMatch(/<option value="2026-10" selected="">October 2026<\/option>/);
    expect(html).toContain("data-report-noprint");
    expect(html).toContain('method="get"');
  });
});
