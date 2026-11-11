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
    expect(html).toContain("Views: 5400 across 9 posts");
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
