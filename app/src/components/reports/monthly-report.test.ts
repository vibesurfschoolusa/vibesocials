import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MonthlyReport } from "@/lib/monthlyReport";

import { MonthlyReportView, ReportMonthPicker } from "./monthly-report";

function report(overrides: Partial<MonthlyReport> = {}): MonthlyReport {
  return {
    month: "2026-10",
    workspaceName: "Surf & Co",
    logoUrl: null,
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

  it("shows the workspace's logo beside its name, at most 48 pixels high, and nothing without one", () => {
    const logo = "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png";
    const html = render(report({ logoUrl: logo }));
    const img = html.match(/<img[^>]*data-report-logo[^>]*>/)?.[0] ?? "";
    expect(img).toContain(`src="${logo}"`);
    expect(img).toContain("max-h-12");
    // The logo sits in the same block as the heading, before it.
    expect(html.indexOf(img)).toBeLessThan(html.indexOf("Surf &amp; Co: October 2026"));
    expect(render(report())).not.toMatch(/<img[^>]*data-report-logo/);
  });

  it("keeps the logo's own shape in print, at most 48 pixels high", () => {
    const block = printBlock();
    expect(block).toMatch(/\[data-report\] img\[data-report-logo\][^{]*\{[^}]*height: auto !important[^}]*max-height: 48px !important/);
    expect(block).toMatch(/\[data-report\] img\[data-report-logo\][^{]*\{[^}]*width: auto !important/);
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

/** The text of the report's @media print block, as rendered. */
function printBlock(): string {
  const html = render(report());
  const css = html.slice(html.indexOf("@media print"));
  return css.slice(0, css.indexOf("</style>"));
}

/** Every selector in globals.css that sets the theme's text colour (--foreground). */
function themeSelectors(): string[] {
  const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const selectors = new Set<string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/--foreground\s*:/.test(match[2])) continue;
    // Only the selector list: drop any statement (an @import) before it.
    const list = match[1].split(";").pop() ?? "";
    for (const selector of list.split(",")) selectors.add(selector.trim());
  }
  return [...selectors];
}

describe("the print sheet beats every theme state", () => {
  it("finds the theme selectors globals.css uses, including the system dark mode one", () => {
    expect(themeSelectors()).toEqual(expect.arrayContaining([":root", ":root:not(.light)", ":root.dark"]));
  });

  it("names each theme selector and sets every colour variable it sets with !important", () => {
    const block = printBlock();
    const rule = block.match(/([^{}]*):root[^{}]*\{([^{}]*--foreground[^{}]*)\}/);
    expect(rule, "a :root rule in the print block").not.toBeNull();
    const selectorList = rule![0].slice(0, rule![0].indexOf("{")).split(",").map((s) => s.trim());
    for (const selector of themeSelectors()) expect(selectorList, selector).toContain(selector);

    const declarations = rule![2].split(";").map((d) => d.trim()).filter((d) => d.startsWith("--"));
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) expect(declaration, declaration).toMatch(/!important$/);
  });

  it("forces every text in the report to dark on white, not only the page", () => {
    const block = printBlock();
    expect(block).toMatch(/\[data-report\] \*[^{]*\{[^}]*color: #000000 !important/);
    expect(block).toMatch(/\[data-report\] \*[^{]*\{[^}]*background: transparent !important/);
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

describe("MonthlyReportView - a post without a file", () => {
  it("shows no picture and no removed-file placeholder", () => {
    const text = { ...report().posts[1], caption: "Wind is onshore", media: null, mediaCount: 0 };
    const html = render(report({ posts: [text] }));
    expect(html).toContain("Wind is onshore");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("File removed");
  });
});

// Go-live check 2026-11-11: on the first of a month the coverage read "1 of 1 days".
describe("MonthlyReportView — counted words", () => {
  it("reads 1 day when one day is counted", () => {
    const listing = {
      daysCovered: 1,
      daysCounted: 1,
      partial: true,
      totals: { views: 1, calls: 0, directionRequests: 0, websiteClicks: 0 },
      previous: null,
    };
    expect(render(report({ inProgress: true, listing }))).toContain("Numbers for 1 of 1 day so far");
  });
});

// Go-live check 2026-11-11: the report printed 1388 where the dashboard printed 1,238.
describe("MonthlyReportView — thousands separators", () => {
  it("formats every number a person reads", () => {
    const base = report();
    const html = render(
      report({
        postCount: 1388,
        posts: [{ ...base.posts[0], mediaCount: 1000, platforms: [{ platform: "X", story: false, url: null, numbers: { views: 1234567 } }] }],
        totals: {
          resultsByPlatform: [{ platform: "Instagram", count: 1388 }],
          numbers: [{ key: "views", label: "Views", sum: 1234567, posts: 1000 }],
        },
        listing: {
          daysCovered: 30,
          daysCounted: 30,
          partial: false,
          totals: { views: 1388, calls: 1000, directionRequests: 999, websiteClicks: 1234567 },
          previous: { views: 1000, calls: 1000, directionRequests: 999, websiteClicks: 1234567 },
        },
        failed: [{ platform: "X", count: 1000 }],
      }),
    );
    expect(html).toContain("Posts published: 1,388");
    expect(html).toContain("Instagram: 1,388");
    expect(html).toContain("Views: 1,234,567 across 1,000 posts");
    expect(html).toContain("1,000 photos");
    expect(html).toContain("Views 1,234,567");
    expect(html).toContain(">1,388<");
    expect(html).toContain(">1,234,567<");
    expect(html).toContain("up 388");
    expect(html).toContain("1,000 posts did not publish on X");
    expect(html).toContain("Showing the 1 most recent of 1,388.");
  });
});
