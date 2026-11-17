import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PostJobResultDTO, PostMetricDTO } from "@/lib/postsDto";

import { DailyMetricStats, PostMetricStats, dailyMetricResults } from "./post-metric-stats";

const metric = (over: Partial<PostMetricDTO> = {}): PostMetricDTO => ({
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
  fetchedAt: "2026-11-10T10:46:00.000Z",
  ...over,
});

const result = (over: Partial<PostJobResultDTO>): PostJobResultDTO => ({
  platform: "instagram",
  status: "success",
  externalPostId: "m1",
  externalPostUrl: null,
  errorMessage: null,
  deferral: null,
  unconfirmed: false,
  metric: metric({ likes: 12 }),
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("PostMetricStats (YouTube)", () => {
  it("is unchanged: views, likes, comments, with a dash for a missing count", () => {
    const html = renderToStaticMarkup(
      createElement(PostMetricStats, { metric: metric({ views: 1200, likes: 5, clicks: 9, saves: 3 }) }),
    );
    expect(html).toContain('aria-label="YouTube engagement"');
    expect(text(html)).toBe("1,200 views 5 likes — comments");
    expect(html).not.toContain("clicks");
    expect(html).not.toContain("once a day");
  });
});

describe("dailyMetricResults", () => {
  it("keeps successful results of the four daily platforms that have a stored number", () => {
    const kept = dailyMetricResults([
      result({ platform: "instagram" }),
      result({ platform: "youtube" }),
      result({ platform: "tiktok" }),
      result({ platform: "pinterest", status: "failed" }),
      result({ platform: "linkedin", externalPostId: null }),
      result({ platform: "facebook_page", metric: null }),
      result({ platform: "facebook_page", metric: metric() }),
    ]);
    expect(kept.map((r) => r.platform)).toEqual(["instagram"]);
  });
});

describe("DailyMetricStats", () => {
  // The day after the sample's fetchedAt: fresh numbers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T08:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows each platform's numbers that are not null, with plain labels, and one line under them", () => {
    const html = renderToStaticMarkup(
      createElement(DailyMetricStats, {
        results: [
          result({ platform: "instagram", metric: metric({ likes: 12, comments: 3 }) }),
          result({ platform: "pinterest", metric: metric({ views: 2400, clicks: 37, saves: 20 }) }),
          result({ platform: "linkedin", metric: metric({ views: 500, likes: 9, comments: 0, shares: 1, clicks: 20 }) }),
        ],
      }),
    );
    const shown = text(html);
    expect(shown).toContain("Instagram 12 likes 3 comments");
    expect(shown).toContain("Pinterest 2,400 views 37 clicks 20 saves");
    expect(shown).toContain("LinkedIn 500 views 9 likes 0 comments 1 share 20 clicks");
    expect(shown.endsWith("Updated once a day.")).toBe(true);
    expect(shown.match(/Updated once a day\./g)).toHaveLength(1);
    expect(shown).not.toContain("—");
    // Instagram gives no views, shares, clicks or saves: none is shown.
    expect(shown).not.toMatch(/Instagram[^P]*views/);
  });

  it("shows no numbers row for a platform the post went to as a Story", () => {
    const results = [
      result({ platform: "instagram", metric: metric({ likes: 12 }) }),
      result({ platform: "facebook_page", externalPostId: "9_1", metric: metric({ likes: 4 }) }),
    ];
    const shown = text(
      renderToStaticMarkup(createElement(DailyMetricStats, { results, storyPlatforms: ["instagram"] })),
    );
    expect(shown).not.toContain("Instagram");
    expect(shown).toContain("Facebook");
    expect(dailyMetricResults(results, ["instagram", "facebook_page"])).toEqual([]);
    expect(
      renderToStaticMarkup(
        createElement(DailyMetricStats, { results, storyPlatforms: ["instagram", "facebook_page"] }),
      ),
    ).toBe("");
  });

  it("renders nothing without a result to show", () => {
    expect(renderToStaticMarkup(createElement(DailyMetricStats, { results: [] }))).toBe("");
  });
});

// Go-live check 2026-11-11: "5 likes · 1 comments" on Activity and the dashboard.
describe("counts take the singular for 1", () => {
  it("YouTube: 1 view, 1 like, 1 comment; 0 and 2 stay plural", () => {
    const one = renderToStaticMarkup(createElement(PostMetricStats, { metric: metric({ views: 1, likes: 1, comments: 1 }) }));
    expect(text(one)).toBe("1 view 1 like 1 comment");
    const other = renderToStaticMarkup(createElement(PostMetricStats, { metric: metric({ views: 0, likes: 2, comments: 1000 }) }));
    expect(text(other)).toBe("0 views 2 likes 1,000 comments");
  });

  it("the daily platforms: every word in the singular for 1", () => {
    const html = renderToStaticMarkup(
      createElement(DailyMetricStats, {
        results: [result({ metric: metric({ views: 1, likes: 1, comments: 1, shares: 1, clicks: 1, saves: 1 }) })],
      }),
    );
    expect(text(html)).toContain("Instagram 1 view 1 like 1 comment 1 share 1 click 1 save");
  });
});

// A German browser: toLocaleString() with no locale given formats as de-DE.
function asGermanBrowser() {
  const original = Number.prototype.toLocaleString;
  return vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return original.call(this, locales ?? "de-DE", options);
  });
}

// F1 round 2: the dashboard's numbers followed the browser's locale (1.238 in
// German) beside the listing card's 1,238.
describe("post numbers use the app's number format, whatever the browser's locale", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [999, "999"],
    [1000, "1,000"],
    [1238, "1,238"],
  ])("%i reads %s", (value, shown) => {
    asGermanBrowser();
    const youtube = renderToStaticMarkup(createElement(PostMetricStats, { metric: metric({ views: value }) }));
    expect(text(youtube)).toContain(`${shown} views`);
    const daily = renderToStaticMarkup(
      createElement(DailyMetricStats, { results: [result({ metric: metric({ likes: value }) })] }),
    );
    expect(text(daily)).toContain(`${shown} likes`);
  });
});

// R43 pages-b L3: numbers the sync no longer reads (posts over 60 days old, or
// reads that keep failing) say when they were last updated.
describe("DailyMetricStats says how fresh the numbers are", () => {
  const shownOn = (now: string, results: PostJobResultDTO[]) => {
    vi.setSystemTime(new Date(now));
    return text(renderToStaticMarkup(createElement(DailyMetricStats, { results })));
  };
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fresh (read within two days): Updated once a day.", () => {
    const shown = shownOn("2026-11-12T09:00:00.000Z", [result({ metric: metric({ likes: 3, fetchedAt: "2026-11-11T06:00:00.000Z" }) })]);
    expect(shown.endsWith("Updated once a day.")).toBe(true);
    expect(shown).not.toContain("Last updated");
  });

  it("3 days old: Last updated <date>, not once a day", () => {
    const fetchedAt = "2026-11-09T06:00:00.000Z";
    const shown = shownOn("2026-11-12T06:00:00.000Z", [result({ metric: metric({ likes: 3, fetchedAt }) })]);
    expect(shown.endsWith(`Last updated ${day(fetchedAt)}.`)).toBe(true);
    expect(shown).not.toContain("once a day");
  });

  it("a post older than 60 days: its last read's date", () => {
    const fetchedAt = "2026-08-30T06:00:00.000Z";
    const shown = shownOn("2026-11-17T06:00:00.000Z", [result({ metric: metric({ likes: 3, fetchedAt }) })]);
    expect(shown.endsWith(`Last updated ${day(fetchedAt)}.`)).toBe(true);
  });

  it("three platforms read on the same old day: one line with that day", () => {
    const shown = shownOn("2026-11-17T06:00:00.000Z", [
      result({ platform: "instagram", metric: metric({ likes: 3, fetchedAt: "2026-11-01T06:00:00.000Z" }) }),
      result({ platform: "facebook_page", externalPostId: "9_1", metric: metric({ likes: 4, fetchedAt: "2026-11-01T07:00:00.000Z" }) }),
      result({ platform: "pinterest", metric: metric({ saves: 2, fetchedAt: "2026-11-01T08:00:00.000Z" }) }),
    ]);
    expect(shown.endsWith(`Last updated ${day("2026-11-01T06:00:00.000Z")}.`)).toBe(true);
    expect(shown.match(/last updated/gi)).toHaveLength(1);
  });

  it("several platforms all fresh: Updated once a day.", () => {
    const shown = shownOn("2026-11-17T09:00:00.000Z", [
      result({ platform: "instagram", metric: metric({ likes: 3, fetchedAt: "2026-11-17T06:00:00.000Z" }) }),
      result({ platform: "pinterest", metric: metric({ saves: 2, fetchedAt: "2026-11-16T06:00:00.000Z" }) }),
    ]);
    expect(shown.endsWith("Updated once a day.")).toBe(true);
    expect(shown).not.toMatch(/last updated/i);
  });

  it("platforms read on different days: each platform's own date, so every date is true", () => {
    const fresh = "2026-11-16T06:00:00.000Z";
    const old = "2026-11-01T06:00:00.000Z";
    const shown = shownOn("2026-11-17T06:00:00.000Z", [
      result({ platform: "instagram", metric: metric({ likes: 3, fetchedAt: fresh }) }),
      result({ platform: "pinterest", metric: metric({ saves: 2, fetchedAt: old }) }),
    ]);
    expect(shown).toContain(`Instagram last updated ${day(fresh)}.`);
    expect(shown).toContain(`Pinterest last updated ${day(old)}.`);
    expect(shown.match(/last updated/gi)).toHaveLength(2);
    expect(shown).not.toContain("once a day");
  });
});

describe("post-metric-stats is a client module", () => {
  it("starts with \"use client\" (it holds state)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./post-metric-stats.tsx", import.meta.url), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
  });
});
