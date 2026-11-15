import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R20 new-customer L1 (= pages L1): when an open tab's session turns to nobody
 * on an app route, the page must stay the same component instance (a half-
 * written post keeps its caption), inside the frame, with one signed-out line.
 *
 * Vitest runs in node with no DOM library, so this mounts the real AppShell
 * with react-dom/client on a tiny fake DOM (just what React's commit uses).
 */

const { path, refresh } = vi.hoisted(() => ({ path: { value: "/posts/new" }, refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => path.value,
  useRouter: () => ({ refresh }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next-auth/react", async () => {
  const { createContext, useContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext) };
});
vi.mock("./sidebar", async () => {
  const { createElement: h } = await import("react");
  return { Sidebar: () => h("nav", null, "SIDEBAR") };
});
vi.mock("./top-bar", async () => {
  const { createElement: h } = await import("react");
  return { TopBar: () => h("header", null, "TOPBAR") };
});
vi.mock("./mobile-drawer", () => ({ MobileDrawer: () => null }));
vi.mock("./time-zone-sync", () => ({ TimeZoneSync: () => null }));
vi.mock("./verify-email-banner", () => ({ VerifyEmailBanner: () => null }));
vi.mock("./workspace-paused-banner", () => ({ WorkspacePausedBanner: () => null }));

import { SessionContext } from "next-auth/react";

import { AppShell } from "./app-shell";
import { html, makeDocument, type FakeNode } from "./fakeDom.testkit";

// ---- the page under the frame: a composer with typed text ----
let mounts = 0;
let setCaption: (value: string) => void = () => {};
function Composer() {
  const [caption, set] = useState("");
  useEffect(() => {
    setCaption = set;
    mounts += 1;
  }, []);
  return createElement("textarea", { value: caption, readOnly: true, "data-caption": caption });
}

const OWNER = { name: "Owner", email: "owner@example.com" };
const SIGNED_IN = { status: "authenticated", data: { user: OWNER, expires: "2099-01-01T00:00:00Z" } };
const ENDED = { status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } };
const NO_USER_FIELDS = { status: "authenticated", data: { user: {}, expires: "2099-01-01T00:00:00Z" } };
const UNAUTHENTICATED = { status: "unauthenticated", data: null };

let root: Root;
let container: FakeNode;
let fakeWindow: Record<string, unknown>;

/** The tab's address, as window.location gives it. */
function at(pathname: string, search: string) {
  path.value = pathname;
  fakeWindow.location = { pathname, search };
}

async function show(session: unknown) {
  await act(async () => {
    root.render(
      createElement(SessionContext.Provider as never, { value: session } as never, createElement(AppShell, null, createElement(Composer))),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  fakeWindow = made.doc.defaultView as Record<string, unknown>;
  vi.stubGlobal("window", fakeWindow);
  at("/posts/new", "?draft=1");
  root = createRoot(container as unknown as HTMLElement);
  mounts = 0;
  refresh.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("AppShell: the session turns to nobody on an open app page", () => {
  for (const [label, nobody] of [
    ["an ended session", ENDED],
    ["a session with an empty user", NO_USER_FIELDS],
    ["unauthenticated", UNAUTHENTICATED],
  ] as const) {
    for (const [pathname, search] of [
      ["/posts/new", "?draft=1"],
      ["/queue", ""],
    ] as const) {
      it(`${pathname}, ${label}: same page instance, frame kept, one signed-out line`, async () => {
        at(pathname, search);
        await show(SIGNED_IN);
        await act(async () => setCaption("Half-written caption"));
        await show(nobody);

        const markup = html(container);
        expect(mounts).toBe(1);
        expect(markup).toContain('data-caption="Half-written caption"');
        expect(markup).toContain("SIDEBAR");
        expect(markup).toContain("TOPBAR");
        expect(markup).toContain('<main id="main-content"');
        expect(markup.match(/role="alert"/g)).toHaveLength(1);
        expect(markup.replace(/<[^>]+>/g, "")).toContain("You were signed out. Sign in again to keep working.");
        expect(markup).toContain(`href="/login?callbackUrl=${encodeURIComponent(pathname + search)}"`);
        expect(refresh).not.toHaveBeenCalled();
      });
    }
  }

  it("a normal signed-in session shows no signed-out line", async () => {
    await show(SIGNED_IN);
    const markup = html(container);
    expect(markup).toContain("SIDEBAR");
    expect(markup).not.toContain("You were signed out");
  });

  it("while the session loads on an app route: frame, no signed-out line", async () => {
    await show({ status: "loading", data: undefined });
    const markup = html(container);
    expect(markup).toContain("SIDEBAR");
    expect(markup).not.toContain("You were signed out");
  });

  it("signing in again clears the line and keeps the page", async () => {
    await show(SIGNED_IN);
    await act(async () => setCaption("kept"));
    await show(ENDED);
    await show(SIGNED_IN);
    const markup = html(container);
    expect(mounts).toBe(1);
    expect(markup).toContain('data-caption="kept"');
    expect(markup).not.toContain("You were signed out");
  });
});
