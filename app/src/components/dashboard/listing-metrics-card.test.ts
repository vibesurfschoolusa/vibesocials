import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ListingMetricsResponse } from "@/app/api/insights/listing-metrics/route";

import { ListingMetricsCardView } from "./listing-metrics-card";

type Listing = NonNullable<ListingMetricsResponse["listing"]>;

const LISTING: Listing = {
  title: "Surf Co",
  windowDays: 28,
  endDay: "2026-11-06",
  current: { views: 1240, calls: 30, directionRequests: 5, websiteClicks: 9 },
  previous: { views: 1240, calls: 18, directionRequests: 8, websiteClicks: 9 },
};
const TODAY = new Date("2026-11-10T15:00:00.000Z");

const render = (listing: Listing | null, today: Date = TODAY) =>
  renderToStaticMarkup(createElement(ListingMetricsCardView, { listing, today }));

describe("ListingMetricsCardView", () => {
  it("shows the four numbers, each with its change against the 28 days before, and where they come from", () => {
    const html = render(LISTING);

    expect(html).toContain("Google listing, 28 days to 6 November");
    for (const label of ["Views", "Calls", "Direction requests", "Website clicks"]) expect(html).toContain(label);
    expect(html).toContain("1,240");
    expect(html).toContain("up 12");
    expect(html).toContain("down 3");
    expect(html).toContain("no change");
    expect(html).toContain("From Google, for Surf Co. Google&#x27;s numbers arrive two to three days late.");
    expect(html).not.toContain("no new numbers");
  });

  it("says Google sent nothing new when the window ends more than 10 days before today", () => {
    expect(render(LISTING, new Date("2026-11-16T12:00:00.000Z"))).not.toContain("no new numbers");
    const html = render(LISTING, new Date("2026-11-17T12:00:00.000Z"));
    expect(html).toContain("Google listing, 28 days to 6 November");
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Google has sent no new numbers since 6 November. Check the Google connection on the Connections page.",
    );
    expect(html).toContain('href="/connections"');
    expect(html).toContain("two to three days late");
  });

  it("names the year when the window ends in another year", () => {
    expect(render({ ...LISTING, endDay: "2025-12-30" })).toContain("28 days to 30 December 2025");
  });

  it("shows no change line without earlier data", () => {
    const html = render({ ...LISTING, previous: null });
    expect(html).not.toContain("up ");
    expect(html).not.toContain("down ");
    expect(html).not.toContain("no change");
  });

  it("renders nothing without a listing or a stored day", () => {
    expect(render(null)).toBe("");
  });
});
