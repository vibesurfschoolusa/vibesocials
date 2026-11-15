import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ status: "authenticated" as string }));
vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  const current = {
    get status() {
      return session.status;
    },
    data: { user: { name: "Jane Doe" } },
  };
  // No provider in these renders: the context's default is the session.
  return { SessionContext: createContext(current), useSession: () => current };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
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

// R15-pages L2: while the browser still loads the session, the page already
// has its h1 and says it is loading.
describe("dashboard while the session loads", () => {
  afterEach(() => {
    session.status = "authenticated";
  });

  it("has the page's h1 and one loading line", () => {
    session.status = "loading";
    const html = renderToStaticMarkup(createElement(DashboardHome, { availablePlatforms: [], setup: null }));
    expect(html).toMatch(/<h1 class="sr-only">Dashboard<\/h1>/);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/<p role="status" class="sr-only">Loading your dashboard…<\/p>/);
  });
});
