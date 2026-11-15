import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { user: { name: "Jane Doe" } } }),
}));
// The cards fetch on their own; only the header is under test.
vi.mock("@/components/dashboard/recent-activity", () => ({ RecentActivity: () => null }));
vi.mock("@/components/dashboard/connection-health", () => ({ ConnectionHealth: () => null }));
vi.mock("@/components/dashboard/getting-started", () => ({ GettingStarted: () => null, WorkingForClients: () => null }));
vi.mock("@/components/dashboard/youtube-metrics-summary", () => ({ YouTubeMetricsSummary: () => null }));
vi.mock("@/components/dashboard/publish-health-card", () => ({ PublishHealthCard: () => null }));
vi.mock("@/components/dashboard/listing-metrics-card", () => ({ ListingMetricsCard: () => null }));
vi.mock("@/components/dashboard/needs-you", () => ({ NeedsYou: () => null }));

import { DashboardHome } from "./dashboard-home";

// R14-pages L3: the page has its h1 while the header's two fetches are still
// loading (the first render, before any effect runs), not only once they end.
describe("dashboard header while loading", () => {
  it("has the page's h1", () => {
    const html = renderToStaticMarkup(createElement(DashboardHome, { availablePlatforms: [], setup: null }));
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
  });
});
