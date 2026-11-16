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

/** The tab's visibility and its visibilitychange listeners, on the fake document. */
let visibility: "visible" | "hidden" = "visible";
let visibilityListeners: Set<() => void>;
/** Storage events this tab dispatched to itself (rereadSessionHere). */
let selfEvents: Array<{ type: string; key: string | null }>;

async function becomeVisible(state: "visible" | "hidden" = "visible") {
  visibility = state;
  await act(async () => {
    for (const listener of [...visibilityListeners]) listener();
  });
}

class FakeStorageEvent {
  type: string;
  key: string | null;
  newValue: string | null;
  constructor(type: string, init: { key?: string; newValue?: string }) {
    this.type = type;
    this.key = init.key ?? null;
    this.newValue = init.newValue ?? null;
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  fakeWindow = made.doc.defaultView as Record<string, unknown>;
  visibility = "visible";
  visibilityListeners = new Set();
  selfEvents = [];
  Object.defineProperty(made.doc, "visibilityState", { get: () => visibility, configurable: true });
  made.doc.addEventListener = (type: string, listener: () => void) => {
    if (type === "visibilitychange") visibilityListeners.add(listener);
  };
  made.doc.removeEventListener = (type: string, listener: () => void) => {
    if (type === "visibilitychange") visibilityListeners.delete(listener);
  };
  fakeWindow.dispatchEvent = (event: { type: string; key: string | null }) => {
    selfEvents.push(event);
    return true;
  };
  vi.stubGlobal("StorageEvent", FakeStorageEvent);
  vi.stubGlobal("document", made.doc);
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
        expect(markup.replace(/<[^>]+>/g, "")).toContain(
          "You were signed out. Sign in again (opens in a new tab), then come back: this page keeps what you wrote.",
        );
        // R21 new-customer L1 (= pages L1): the link opens a new tab, so this page and its work stay;
        // that tab lands on /signed-in-again, not a second, empty copy of this page.
        expect(markup).toMatch(/<a href="\/login\?callbackUrl=%2Fsigned-in-again" [^>]*target="_blank" rel="noopener noreferrer"/);
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

// R21 security L1: a visitor who never signed in opens a missing /logo.png
// (the proxy skips image-looking addresses, so no sign-in redirect). The 404
// is not public, but nobody was ever signed in here: bare page, no line.
describe("AppShell: a tab whose session never named anyone", () => {
  it("a missing /logo.png for a visitor who never signed in: frame only while loading, then bare, no line, no read", async () => {
    at("/logo.png", "");
    await show({ status: "loading", data: undefined });
    expect(html(container)).toContain("SIDEBAR");
    await show(UNAUTHENTICATED);
    const markup = html(container);
    expect(markup).not.toContain("SIDEBAR");
    expect(markup).not.toContain("TOPBAR");
    expect(markup).not.toContain("You were signed out");
    expect(markup).toContain("<textarea");
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("an ended session from the very first read: bare, no line", async () => {
    at("/logo.png", "");
    await show(ENDED);
    const markup = html(container);
    expect(markup).not.toContain("SIDEBAR");
    expect(markup).not.toContain("You were signed out");
  });

  it("once the tab named someone, the frame and the line stay for it", async () => {
    at("/logo.png", "");
    await show(SIGNED_IN);
    await show(UNAUTHENTICATED);
    const markup = html(container);
    expect(markup).toContain("SIDEBAR");
    expect(markup).toContain("You were signed out");
  });
});

// R21 pages L2: after a password sign-in in another tab, this tab's null
// session is never re-read on focus by next-auth (react/index.js:408-412).
// While the line shows, a return to the tab re-reads it here.
describe("AppShell: the line re-reads the session when the tab comes back", () => {
  it("visible while the line shows: one re-read of this tab; the sign-in then clears the line, page kept", async () => {
    await show(SIGNED_IN);
    await act(async () => setCaption("kept across tabs"));
    await show(UNAUTHENTICATED);
    expect(html(container)).toContain("You were signed out");
    expect(selfEvents).toEqual([]);

    await becomeVisible("hidden");
    expect(selfEvents).toEqual([]);
    await becomeVisible("visible");
    expect(selfEvents).toHaveLength(1);
    expect(selfEvents[0]).toMatchObject({ type: "storage", key: "nextauth.message" });

    // next-auth's receiver re-reads the server, which now names the person.
    await show(SIGNED_IN);
    const markup = html(container);
    expect(mounts).toBe(1);
    expect(markup).toContain('data-caption="kept across tabs"');
    expect(markup).not.toContain("You were signed out");
    expect(visibilityListeners.size).toBe(0);
  });

  it("no line, no listener: a signed-in tab does not re-read on its own", async () => {
    await show(SIGNED_IN);
    await becomeVisible("visible");
    expect(selfEvents).toEqual([]);
    expect(visibilityListeners.size).toBe(0);
  });
});

// R21 pages L3: a 401 in the focused tab. The listener (session-provider.tsx)
// reads the server and ends the stale session; next-auth then sets this tab's
// session to null (signOut({ redirect: false }) -> _getSession storage read).
describe("AppShell: a 401 in the focused tab", () => {
  it("Schedule gets a marked 401: the line appears, frame and text kept", async () => {
    const { watchSignedOutAnswers, SIGNED_OUT_HEADER } = await import("@/components/session-provider");
    await show(SIGNED_IN);
    await act(async () => setCaption("about to schedule"));

    fakeWindow.location = { pathname: "/posts/new", search: "?draft=1", origin: "https://app.example.test" };
    let ended = 0;
    fakeWindow.fetch = async () =>
      new Response('{"error":"You were signed out. Sign in again."}', {
        status: 401,
        headers: { [SIGNED_OUT_HEADER]: "1" },
      });
    const stop = watchSignedOutAnswers(fakeWindow as unknown as Window, {
      read: async () => ({ kind: "signedOut" }),
      end: () => {
        ended += 1;
      },
      generation: () => 0,
      // This harness draws the shell without AppSessionProvider's SessionPresence.
      namesSomeone: () => true,
    });
    await act(async () => {
      await (fakeWindow.fetch as typeof fetch)("/api/posts", { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    stop();
    expect(ended).toBe(1);
    // What next-auth does after signOut({ redirect: false }): this tab's session becomes null.
    await show(UNAUTHENTICATED);

    const markup = html(container);
    expect(mounts).toBe(1);
    expect(markup).toContain('data-caption="about to schedule"');
    expect(markup).toContain("SIDEBAR");
    expect(markup).toContain("You were signed out");
  });
});
