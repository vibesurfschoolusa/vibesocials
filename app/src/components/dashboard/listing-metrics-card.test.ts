import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ListingMetricsResponse } from "@/app/api/insights/listing-metrics/route";

import { ListingMetricsCardView } from "./listing-metrics-card";

type Listing = NonNullable<ListingMetricsResponse["listing"]>;

const LISTING: Listing = {
  title: "Surf Co",
  windowDays: 28,
  endDay: "2026-11-07",
  current: { views: 1240, calls: 30, directionRequests: 5, websiteClicks: 9 },
  previous: { views: 1240, calls: 18, directionRequests: 8, websiteClicks: 9 },
};

const render = (listing: Listing | null) => renderToStaticMarkup(createElement(ListingMetricsCardView, { listing }));

describe("ListingMetricsCardView", () => {
  it("shows the four numbers, each with its change against the 28 days before, and where they come from", () => {
    const html = render(LISTING);

    expect(html).toContain("Google listing, last 28 days");
    for (const label of ["Views", "Calls", "Direction requests", "Website clicks"]) expect(html).toContain(label);
    expect(html).toContain("1,240");
    expect(html).toContain("up 12");
    expect(html).toContain("down 3");
    expect(html).toContain("no change");
    expect(html).toContain("From Google, for Surf Co. Google&#x27;s numbers arrive two to three days late.");
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
