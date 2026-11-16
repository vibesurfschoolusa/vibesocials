import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignedOutAlert, signInAgainLink } from "./signed-out-alert";

/**
 * R22 new-customer / pages (unconfirmed, well known): an iPhone home-screen
 * web app keeps its own cookies, apart from Safari's, so a target="_blank"
 * link opens Safari and a sign-in there never reaches the app. In standalone
 * display mode the link opens Log in in the same view and comes back to this
 * page; everywhere else it stays a new tab to /signed-in-again (#177).
 */

function fakeWindow(opts: { displayStandalone?: boolean; navigatorStandalone?: boolean; path?: string }) {
  const url = new URL(`https://app.example${opts.path ?? "/posts/new?draft=1"}`);
  return {
    matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" && !!opts.displayStandalone }),
    navigator: opts.navigatorStandalone === undefined ? {} : { standalone: opts.navigatorStandalone },
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signInAgainLink", () => {
  it("in a browser tab: a new tab to /signed-in-again, as #177 made it", () => {
    expect(signInAgainLink(fakeWindow({}) as unknown as Window)).toEqual({
      href: "/login?callbackUrl=%2Fsigned-in-again",
      newTab: true,
    });
    expect(signInAgainLink(fakeWindow({ navigatorStandalone: false }) as unknown as Window).newTab).toBe(true);
  });

  it("installed (display-mode standalone): the same view, back to this page", () => {
    expect(signInAgainLink(fakeWindow({ displayStandalone: true }) as unknown as Window)).toEqual({
      href: `/login?callbackUrl=${encodeURIComponent("/posts/new?draft=1")}`,
      newTab: false,
    });
  });

  it("an iPhone home-screen app (navigator.standalone): the same view, back to this page", () => {
    expect(signInAgainLink(fakeWindow({ navigatorStandalone: true, path: "/queue" }) as unknown as Window)).toEqual({
      href: "/login?callbackUrl=%2Fqueue",
      newTab: false,
    });
  });

  it("no window, or one without matchMedia: the new-tab link", () => {
    expect(signInAgainLink(undefined).newTab).toBe(true);
    expect(signInAgainLink({ navigator: {}, location: { pathname: "/", search: "", hash: "" } } as unknown as Window).newTab).toBe(
      true,
    );
  });
});

describe("SignedOutAlert", () => {
  it("in a browser tab: the new-tab link and its sentence", () => {
    vi.stubGlobal("window", fakeWindow({}));
    const html = renderToStaticMarkup(createElement(SignedOutAlert));
    expect(html).toContain('<a href="/login?callbackUrl=%2Fsigned-in-again" target="_blank" rel="noopener"');
    expect(html).toContain("Sign in again in a new tab</a>, then come back: this page keeps what you wrote.");
  });

  it("installed: the same-view link, and it says to copy unsent work first", () => {
    vi.stubGlobal("window", fakeWindow({ navigatorStandalone: true }));
    const html = renderToStaticMarkup(createElement(SignedOutAlert));
    expect(html).toContain(`<a href="/login?callbackUrl=${encodeURIComponent("/posts/new?draft=1").replace(/&/g, "&amp;")}" class=`);
    expect(html).not.toContain("target=");
    expect(html).toContain("You were signed out. <a");
    expect(html).toContain(">Sign in again</a>. Copy anything you haven&#x27;t sent first: this page will reload.");
    expect(html).not.toContain("keeps what you wrote");
  });
});
