import { createElement, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { path } = vi.hoisted(() => ({ path: { value: "/" } }));

vi.mock("next/navigation", () => ({ usePathname: () => path.value }));
vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext) };
});
vi.mock("./sidebar", () => ({ Sidebar: () => createElement("nav", null, "SIDEBAR") }));
vi.mock("./top-bar", () => ({ TopBar: () => createElement("header", null, "TOPBAR") }));
vi.mock("./mobile-drawer", () => ({ MobileDrawer: () => null }));
vi.mock("./time-zone-sync", () => ({ TimeZoneSync: () => null }));
vi.mock("./verify-email-banner", () => ({ VerifyEmailBanner: () => null }));
vi.mock("./workspace-paused-banner", () => ({ WorkspacePausedBanner: () => null }));

import { SessionContext } from "next-auth/react";

import { AppShell } from "./app-shell";

const OWNER = { name: "Owner", email: "owner@example.com" };
const ENDED = { status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } };
const SIGNED_IN = { status: "authenticated", data: { user: OWNER, expires: "2099-01-01T00:00:00Z" } };

/** The page bare, as the server rendered it (the toast region follows it). */
const BARE = /^<p>PAGE<\/p><div aria-live/;

function render(pathname: string, session: unknown): string {
  path.value = pathname;
  return renderToStaticMarkup(
    createElement(
      SessionContext.Provider as never,
      { value: session } as never,
      createElement(AppShell, null, createElement("p", null, "PAGE")),
    ),
  );
}

// R19 new-customer L1 (= pages L1): a session the server ended answers
// {"expires":"1970-..."} with no user, which next-auth still calls
// "authenticated". The app frame follows the same rule as the header: signed
// in means the session names someone.
describe("AppShell: who gets the app frame", () => {
  it("a cached session with no user gets no frame around the Landing", () => {
    expect(render("/", ENDED)).toMatch(BARE);
  });

  // R20 new-customer L1: an app route never loses its frame (that remounted
  // the page and lost unsent work); it says the person was signed out instead.
  it("a session naming nobody on an app route keeps the frame and says signed out", () => {
    for (const session of [
      ENDED,
      { status: "authenticated", data: { user: {}, expires: "2099-01-01T00:00:00Z" } },
      { status: "unauthenticated", data: null },
    ]) {
      const html = render("/queue", session);
      expect(html).toContain("SIDEBAR");
      expect(html).toContain('<main id="main-content"');
      expect(html.replace(/<[^>]+>/g, "")).toContain("You were signed out. Sign in again to keep working.");
      expect(html).toMatch(/role="alert"/);
      expect(html).toContain('href="/login?callbackUrl=%2Fqueue"');
    }
  });

  it("a session naming nobody on a public page: no frame, no line, as today", () => {
    expect(render("/login", ENDED)).toMatch(BARE);
    expect(render("/help", { status: "unauthenticated", data: null })).toMatch(BARE);
  });

  it("while the session loads on an app route, the frame shows as today", () => {
    const html = render("/queue", { status: "loading", data: undefined });
    expect(html).toContain("SIDEBAR");
    expect(html).toContain("TOPBAR");
    expect(html).toContain("<p>PAGE</p>");
  });

  it("while the session loads on / or a public page, no frame, as today", () => {
    expect(render("/", { status: "loading", data: undefined })).toMatch(BARE);
    expect(render("/login", { status: "loading", data: undefined })).toMatch(BARE);
  });

  it("a signed-in person gets the frame on the dashboard and app routes, unchanged", () => {
    for (const pathname of ["/", "/queue"]) {
      const html = render(pathname, SIGNED_IN);
      expect(html).toContain("SIDEBAR");
      expect(html).toContain('<main id="main-content"');
    }
    expect(render("/login", SIGNED_IN)).toMatch(BARE);
  });

  it("signed out: no frame", () => {
    expect(render("/", { status: "unauthenticated", data: null })).toMatch(BARE);
  });
});
