import { describe, expect, it } from "vitest";

import type { MonthlyReport } from "@/lib/monthlyReport";

import { buildMonthlyReportEmail } from "./monthlyReportEmail";

function report(overrides: Partial<MonthlyReport> = {}): MonthlyReport {
  return {
    month: "2026-10",
    workspaceName: "Surf Co",
    logoUrl: null,
    inProgress: false,
    postCount: 12,
    posts: [],
    totals: {
      resultsByPlatform: [
        { platform: "Instagram", count: 10 },
        { platform: "Facebook", count: 7 },
      ],
      numbers: [
        { key: "views", label: "Views", sum: 5400, posts: 9 },
        { key: "likes", label: "Likes", sum: 312, posts: 1 },
      ],
    },
    listing: null,
    failed: [],
    ...overrides,
  };
}

const BASE = "https://app.example.com";
const build = (r: MonthlyReport, extra: Partial<{ appBaseUrl: string | null; hasClientLink: boolean }> = {}) =>
  buildMonthlyReportEmail({ report: r, appBaseUrl: BASE, hasClientLink: false, ...extra });

describe("buildMonthlyReportEmail", () => {
  it("names the workspace and the month in the subject", () => {
    expect(build(report()).subject).toBe("Surf Co: your report for October 2026");
  });

  it("states the posts published and the count per platform", () => {
    const { html } = build(report());
    expect(html).toContain("Posts published: 12");
    expect(html).toContain("Instagram: 10");
    expect(html).toContain("Facebook: 7");
  });

  it("gives each number with a value as its sum and the posts it covers, as the report does", () => {
    const { html } = build(report());
    // Was "5400" before the go-live check (2026-11-11): every number now has a thousands separator.
    expect(html).toContain("Views: 5,400 across 9 posts");
    expect(html).toContain("Likes: 312 across 1 post");
    expect(html).not.toContain("Comments");
  });

  it("gives the Google listing's four numbers with their coverage only when the report has them", () => {
    expect(build(report()).html).not.toContain("Google listing");
    const { html } = build(
      report({
        listing: {
          daysCovered: 27,
          daysCounted: 31,
          partial: false,
          totals: { views: 120, calls: 5, directionRequests: 7, websiteClicks: 9 },
          previous: null,
        },
      }),
    );
    expect(html).toContain("Google listing");
    expect(html).toContain("Numbers for 27 of 31 days.");
    expect(html).toContain("Views (Search and Maps): 120");
    expect(html).toContain("Calls: 5");
    expect(html).toContain("Direction requests: 7");
    expect(html).toContain("Website clicks: 9");
  });

  it("links to the month's report from NEXTAUTH_URL, without a doubled slash", () => {
    expect(build(report()).html).toContain(`href="${BASE}/reports?month=2026-10"`);
    expect(build(report(), { appBaseUrl: `${BASE}/` }).html).toContain(`href="${BASE}/reports?month=2026-10"`);
    const plain = build(report(), { appBaseUrl: null }).html;
    expect(plain).not.toContain("href=");
    expect(plain).toContain("Open Reports in Vibe Socials");
  });

  it("says the client can open the same report when there is a link, never giving the link", () => {
    const withLink = build(report(), { hasClientLink: true }).html;
    expect(withLink).toContain("Your client can open the same report from their review link.");
    expect(withLink).not.toContain("/v/");
    expect(build(report()).html).not.toContain("Your client can open");
  });

  it("puts the logo at the top when there is one", () => {
    const logo = "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png";
    const { html } = build(report({ logoUrl: logo }));
    expect(html.indexOf(`<img src="${logo}"`)).toBe(0);
    expect(build(report()).html).not.toContain("<img");
  });

  it("says how to switch it off", () => {
    expect(build(report()).html).toContain("To stop this monthly email, turn it off in Settings, Notifications.");
  });

  it("escapes every value", () => {
    const { html } = build(
      report({
        workspaceName: `<b>Surf & "Co"</b>`,
        logoUrl: `https://x.example/a.png"><script>alert(1)</script>`,
        totals: {
          resultsByPlatform: [{ platform: "<i>Insta</i>", count: 1 }],
          numbers: [{ key: "likes", label: "<u>Likes</u>", sum: 1, posts: 1 }],
        },
      }),
      { appBaseUrl: `https://app.example.com/"><script>` },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<u>");
    expect(html).toContain("&lt;b&gt;Surf &amp; &quot;Co&quot;&lt;/b&gt;");
  });
});

// Go-live check 2026-11-11: the email reads its numbers as the report page does.
// 1 takes the singular, every other number the plural; every number a person
// reads has a thousands separator.
describe("buildMonthlyReportEmail — counted words and thousands separators", () => {
  const withPosts = (posts: number) =>
    build(report({ totals: { resultsByPlatform: [], numbers: [{ key: "likes", label: "Likes", sum: 4, posts }] } })).html;

  it("0 posts: plural", () => {
    expect(withPosts(0)).toContain("Likes: 4 across 0 posts");
  });

  it("1 post: singular", () => {
    expect(withPosts(1)).toContain("Likes: 4 across 1 post");
  });

  it("2 posts: plural", () => {
    expect(withPosts(2)).toContain("Likes: 4 across 2 posts");
  });

  it("1388 posts: plural, with a separator", () => {
    expect(withPosts(1388)).toContain("Likes: 4 across 1,388 posts");
  });

  const listing = (daysCovered: number, daysCounted: number) => ({
    daysCovered,
    daysCounted,
    partial: true,
    totals: { views: 1388, calls: 1000, directionRequests: 999, websiteClicks: 1234567 },
    previous: null,
  });

  it('reads "1 of 1 day" on the first of a month', () => {
    expect(build(report({ inProgress: true, listing: listing(1, 1) })).html).toContain("Numbers for 1 of 1 day so far.");
  });

  it('reads "10 of 11 days"', () => {
    expect(build(report({ inProgress: true, listing: listing(10, 11) })).html).toContain(
      "Numbers for 10 of 11 days so far.",
    );
  });

  it("formats the posts published, the per-platform counts and the listing's numbers", () => {
    const { html } = build(
      report({
        postCount: 1388,
        totals: {
          resultsByPlatform: [{ platform: "Instagram", count: 1234567 }],
          numbers: [{ key: "views", label: "Views", sum: 1234567, posts: 1000 }],
        },
        listing: listing(10, 11),
      }),
    );
    expect(html).toContain("Posts published: 1,388");
    expect(html).toContain("Instagram: 1,234,567");
    expect(html).toContain("Views: 1,234,567 across 1,000 posts");
    expect(html).toContain("Views (Search and Maps): 1,388");
    expect(html).toContain("Calls: 1,000");
    expect(html).toContain("Direction requests: 999");
    expect(html).toContain("Website clicks: 1,234,567");
  });

  it("formats how many posts the numbers cover when not all are listed", () => {
    const posts = Array.from({ length: 1000 }, () => report().posts[0]);
    expect(build(report({ postCount: 1388, posts })).html).toContain("The numbers cover the 1,000 most recent posts.");
  });

  it("the subject carries no count, and there is no plain-text part", () => {
    const email = build(report({ postCount: 1388 }));
    expect(email.subject).toBe("Surf Co: your report for October 2026");
    expect(Object.keys(email).sort()).toEqual(["html", "subject"]);
  });

  it("an email with nothing to count is exactly as before", () => {
    const email = build(report({ postCount: 0, totals: { resultsByPlatform: [], numbers: [] } }));
    expect(email).toEqual({
      subject: "Surf Co: your report for October 2026",
      html: [
        "<p>Here is the report for <strong>Surf Co</strong> for October 2026.</p>",
        "<p>Posts published: 0</p>",
        '<p><a href="https://app.example.com/reports?month=2026-10" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">Open the report</a></p>',
        "<p>To stop this monthly email, turn it off in Settings, Notifications.</p>",
        "<p>— Vibe Socials</p>",
      ].join("\n"),
    });
  });
});
