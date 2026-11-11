import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
    expect(shown).toContain("LinkedIn 500 views 9 likes 0 comments 1 shares 20 clicks");
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
