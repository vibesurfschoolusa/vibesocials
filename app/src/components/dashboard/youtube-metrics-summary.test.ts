import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
