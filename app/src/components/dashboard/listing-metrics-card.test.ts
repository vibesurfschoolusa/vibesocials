import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const render = (listing: Listing | null, today: Date = TODAY, viewerRole: "owner" | "member" | null = "owner") =>
  renderToStaticMarkup(createElement(ListingMetricsCardView, { listing, today, viewerRole }));

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
    // R35 new-customer L3: the Connections section of Settings, by its real name.
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Google has sent no new numbers since 6 November. Check Google Business Profile under Connections in Settings.",
    );
    expect(html).toContain('href="/settings#connections"');
    expect(html).not.toContain('href="/connections"');
    expect(html).toContain("two to three days late");
  });

  it("tells a member the workspace owner can reconnect it", () => {
    const html = render(LISTING, new Date("2026-11-17T12:00:00.000Z"), "member");
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Google has sent no new numbers since 6 November. The workspace owner can reconnect Google Business Profile under Connections in Settings.",
    );
    expect(html).toContain('href="/settings#connections"');
  });

  // Lead review (R35): the dashboard's setup can fail to load, and then the
  // role is unknown: a sentence true for an owner and a member alike.
  it("with the role unknown, says an owner can reconnect it", () => {
    const html = render(LISTING, new Date("2026-11-17T12:00:00.000Z"), null);
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Google has sent no new numbers since 6 November. An owner can reconnect Google Business Profile under Connections in Settings.",
    );
    expect(html).toContain('href="/settings#connections"');
  });

  it("the dashboard passes the role it knows, or null when setup could not be read", () => {
    const home = readFileSync(join(__dirname, "dashboard-home.tsx"), "utf8");
    expect(home).toContain("<ListingMetricsCard workspaceId={workspaceId} viewerRole={setup?.role ?? null} />");
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

// Go-live check 2026-11-11: a number beside a counted word takes the singular for 1.
describe("ListingMetricsCardView — the window's days", () => {
  it("reads 1 day for a one-day window and 28 days otherwise", () => {
    expect(render({ ...LISTING, windowDays: 1 })).toContain("1 day to");
    expect(render(LISTING)).toContain("28 days to");
  });
});

// R35 new-customer L3: /connections only redirects old bookmarks to the top of
// Settings; every link in the app goes to the Connections section itself.
describe("no internal link to /connections", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("names /settings#connections, never /connections", () => {
    const src = join(__dirname, "../..");
    // A path literal, or an address built on the app's URL; robots.ts keeps it
    // off search engines, which is not a link.
    const offenders = files(src)
      .filter((path) => !path.endsWith(join("app", "robots.ts")))
      .filter((path) => /(?:["'`]|\})\/connections(?:["'`#?]|\/(?!api))/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    // The redirect for old bookmarks stays.
    expect(readFileSync(join(src, "app/connections/page.tsx"), "utf8")).toMatch(/redirect\(/);
  });
});
