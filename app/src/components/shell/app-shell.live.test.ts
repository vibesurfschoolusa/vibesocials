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

/**
 * What GET /api/auth/session answers when the page asks the server (review of
 * FF1: next-auth also says "unauthenticated" after a failed fetch, so the line
 * waits for the server's own answer).
 */
type ServerReply = { status: number; body: unknown } | "offline";
let serverReply: ServerReply;
const sessionFetch = vi.fn(async (input: unknown) => {
  if (input !== "/api/auth/session") throw new Error(`unexpected fetch ${String(input)}`);
  if (serverReply === "offline") throw new TypeError("Failed to fetch");
  const { status, body } = serverReply;
  return { status, json: async () => body } as unknown as Response;
});
const NOBODY_REPLY: ServerReply = { status: 200, body: { expires: "1970-01-01T00:00:00.000Z" } };

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
  // Let the server read (fetch, then json) finish and render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  fakeWindow = made.doc.defaultView as Record<string, unknown>;
  vi.stubGlobal("window", fakeWindow);
  serverReply = NOBODY_REPLY;
  sessionFetch.mockClear();
  vi.stubGlobal("fetch", sessionFetch);
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

  // FF1 review: next-auth 4.24.15 also reports "unauthenticated" when its
  // session fetch fails, for someone still signed in. The line shows only when
  // the server itself says nobody; otherwise frame and page stay as they are.
  for (const [label, reply] of [
    ["offline", "offline"],
    ["a 500", { status: 500, body: { message: "x" } }],
    ["a 200 naming the person", { status: 200, body: { user: { name: "Owner", email: "owner@example.com" } } }],
    ["a 200 that is not a JSON object", { status: 200, body: "nope" }],
  ] as const) {
    it(`the session reads as nobody but the server answers ${label}: no line, page kept`, async () => {
      serverReply = reply as ServerReply;
      await show(SIGNED_IN);
      await act(async () => setCaption("still mine"));
      await show(UNAUTHENTICATED);
      const markup = html(container);
      expect(sessionFetch).toHaveBeenCalledTimes(1);
      expect(mounts).toBe(1);
      expect(markup).toContain('data-caption="still mine"');
      expect(markup).toContain("SIDEBAR");
      expect(markup).not.toContain("You were signed out");
      expect(markup).not.toMatch(/role="alert"/);
    });
  }

  it("a 200 naming nobody: the line, after one read", async () => {
    await show(SIGNED_IN);
    expect(sessionFetch).not.toHaveBeenCalled();
    await show(ENDED);
    await show(ENDED);
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(html(container).match(/You were signed out/g)).toHaveLength(1);
  });

  it("the line waits for the server: nothing before its answer", async () => {
    let answer: (value: Response) => void = () => {};
    sessionFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    await show(SIGNED_IN);
    await show(ENDED);
    expect(html(container)).not.toContain("You were signed out");
    await act(async () => {
      answer({ status: 200, json: async () => NOBODY_REPLY.body } as unknown as Response);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(html(container)).toContain("You were signed out");
  });

  it("an unknown read, then a later session change (focus, another tab): read again", async () => {
    serverReply = "offline";
    await show(SIGNED_IN);
    await show(UNAUTHENTICATED);
    expect(html(container)).not.toContain("You were signed out");
    serverReply = NOBODY_REPLY;
    await show({ ...ENDED });
    expect(sessionFetch).toHaveBeenCalledTimes(2);
    expect(html(container)).toContain("You were signed out");
  });

  it("a normal signed-in session shows no signed-out line", async () => {
    await show(SIGNED_IN);
    const markup = html(container);
    expect(markup).toContain("SIDEBAR");
    expect(markup).not.toContain("You were signed out");
    expect(sessionFetch).not.toHaveBeenCalled();
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
    expect(html(container)).toContain("You were signed out");
    await show(SIGNED_IN);
    const markup = html(container);
    expect(mounts).toBe(1);
    expect(markup).toContain('data-caption="kept"');
    expect(markup).not.toContain("You were signed out");
  });
});
