import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_ORDER } from "@/lib/platforms";
import type { PostJobDTO } from "@/lib/postsDto";

import { YouTubeMetricsSummary } from "./youtube-metrics-summary";

const JOBS = [
  {
    id: "job",
    results: [
      {
        platform: "youtube",
        status: "success",
        externalPostId: "v1",
        metric: { views: 10, likes: 2, comments: 1 },
      },
    ],
  },
] as unknown as PostJobDTO[];

const render = (availablePlatforms: readonly (typeof PLATFORM_ORDER)[number][]) =>
  renderToStaticMarkup(createElement(YouTubeMetricsSummary, { jobs: JOBS, availablePlatforms }));

// Go-live check 2026-11-11: the card named Pinterest on a site that does not offer it.
describe("YouTubeMetricsSummary — the daily platforms it names", () => {
  it("names Pinterest when the site offers it", () => {
    expect(render(PLATFORM_ORDER)).toContain("Instagram, Facebook, LinkedIn and Pinterest numbers update once a day");
  });

  it("does not name Pinterest when it is not configured", () => {
    const html = render(PLATFORM_ORDER.filter((platform) => platform !== "pinterest"));
    expect(html).toContain("Instagram, Facebook and LinkedIn numbers update once a day");
    expect(html).not.toContain("Pinterest");
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

// F1 round 2: the card's totals followed the browser's locale (1.238 in German).
describe("YouTubeMetricsSummary — the app's number format, whatever the browser's locale", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [999, "999"],
    [1000, "1,000"],
    [1238, "1,238"],
  ])("%i reads %s", (value, shown) => {
    asGermanBrowser();
    const jobs = [
      {
        id: "job",
        results: [
          { platform: "youtube", status: "success", externalPostId: "v1", metric: { views: value, likes: 0, comments: 0 } },
        ],
      },
    ] as unknown as PostJobDTO[];
    const html = renderToStaticMarkup(createElement(YouTubeMetricsSummary, { jobs, availablePlatforms: PLATFORM_ORDER }));
    expect(html).toContain(`>${shown}</dd>`);
  });
});
