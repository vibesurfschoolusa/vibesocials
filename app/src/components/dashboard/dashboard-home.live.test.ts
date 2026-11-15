import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R20 new-customer L1 (= pages L1) on "/": the server rendered the Dashboard
 * for someone, then the open tab's session names nobody. The page asks the
 * server once (router.refresh()), which renders the Landing; it never signs
 * anyone out from here. Mounted for real inside the AppShell, which drops its
 * frame on "/" for nobody (R19), on the fake DOM from the shell's tests.
 */

const { refresh, signOut } = vi.hoisted(() => ({ refresh: vi.fn(), signOut: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh }) }));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next-auth/react", async () => {
  const { createContext, useContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext), signOut };
});
vi.mock("@/components/shell/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/top-bar", () => ({ TopBar: () => null }));
vi.mock("@/components/shell/mobile-drawer", () => ({ MobileDrawer: () => null }));
vi.mock("@/components/shell/time-zone-sync", () => ({ TimeZoneSync: () => null }));
vi.mock("@/components/shell/verify-email-banner", () => ({ VerifyEmailBanner: () => null }));
vi.mock("@/components/shell/workspace-paused-banner", () => ({ WorkspacePausedBanner: () => null }));
vi.mock("@/hooks/usePostJobs", () => ({ usePostJobs: () => ({ jobs: null, loading: true, error: null, reload: () => {} }) }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ connections: null, loading: true, error: null, reload: () => {} }) }));
vi.mock("@/components/dashboard/recent-activity", () => ({ RecentActivity: () => null }));
vi.mock("@/components/dashboard/connection-health", () => ({ ConnectionHealth: () => null }));
vi.mock("@/components/dashboard/getting-started", () => ({ GettingStarted: () => null, WorkingForClients: () => null }));
vi.mock("@/components/dashboard/youtube-metrics-summary", () => ({ YouTubeMetricsSummary: () => null }));
vi.mock("@/components/dashboard/publish-health-card", () => ({ PublishHealthCard: () => null }));
vi.mock("@/components/dashboard/listing-metrics-card", () => ({ ListingMetricsCard: () => null }));
vi.mock("@/components/dashboard/needs-you", () => ({ NeedsYou: () => null }));

import { SessionContext } from "next-auth/react";

import { AppShell } from "@/components/shell/app-shell";
import { html, makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { DashboardHome } from "./dashboard-home";

const SIGNED_IN = { status: "authenticated", data: { user: { name: "Jane Doe", email: "jane@example.com" }, expires: "2099-01-01T00:00:00Z" } };
const ENDED = { status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } };
const UNAUTHENTICATED = { status: "unauthenticated", data: null };

let root: Root;
let container: FakeNode;

// GET /api/auth/session: the refresh waits for the server to say nobody (FF1
// review: a failed next-auth fetch also reads "unauthenticated").
type ServerReply = { status: number; body: unknown } | "offline";
let serverReply: ServerReply;
const sessionFetch = vi.fn(async () => {
  if (serverReply === "offline") throw new TypeError("Failed to fetch");
  const { status, body } = serverReply;
  return { status, json: async () => body } as unknown as Response;
});

async function show(session: unknown) {
  await act(async () => {
    root.render(
      createElement(
        SessionContext.Provider as never,
        { value: session } as never,
        createElement(AppShell, null, createElement(DashboardHome, { availablePlatforms: [], setup: null })),
      ),
    );
  });
  // Let the server read finish.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  serverReply = { status: 200, body: { expires: "1970-01-01T00:00:00.000Z" } };
  sessionFetch.mockClear();
  vi.stubGlobal("fetch", sessionFetch);
  root = createRoot(container as unknown as HTMLElement);
  refresh.mockReset();
  signOut.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Dashboard on / when the session turns to nobody", () => {
  for (const [label, nobody] of [
    ["an ended session", ENDED],
    ["unauthenticated", UNAUTHENTICATED],
  ] as const) {
    it(`${label}: the page is asked for once, nobody is signed out`, async () => {
      await show(SIGNED_IN);
      expect(html(container)).toContain('<main id="main-content"');
      expect(refresh).not.toHaveBeenCalled();

      await show(nobody);
      await show(nobody);
      await show({ ...UNAUTHENTICATED });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(signOut).not.toHaveBeenCalled();
      // The Dashboard does not keep drawing without its frame meanwhile.
      expect(html(container)).not.toContain('<main id="main-content"');
      expect(html(container)).toContain("Loading your dashboard");
    });
  }

  for (const [label, reply] of [
    ["offline", "offline"],
    ["a 500", { status: 500, body: {} }],
    ["a 200 naming the person", { status: 200, body: { user: { name: "Jane Doe", email: "jane@example.com" } } }],
  ] as const) {
    it(`the server read answers ${label}: no refresh, nobody signed out`, async () => {
      serverReply = reply as ServerReply;
      await show(SIGNED_IN);
      await show(UNAUTHENTICATED);
      expect(sessionFetch).toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
    });
  }

  it("a signed-in session never refreshes", async () => {
    await show(SIGNED_IN);
    await show(SIGNED_IN);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("while the session loads, no refresh", async () => {
    await show({ status: "loading", data: undefined });
    expect(refresh).not.toHaveBeenCalled();
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});
