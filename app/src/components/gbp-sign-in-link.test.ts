import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INSTALLED_APP_HINT, NewTabHint, SignInAgainLink, SignInAgainLinkView, isInstalledApp } from "./gbp-sign-in-link";

const HREF = "/api/auth/google_business_profile/start?workspaceId=ws-1";

// R25 pages L2: the sign-in leaves this page for Google and comes back to
// Settings, so in the same tab a typed reply was lost. It opens in a new tab,
// and says so, so this page and what is typed in it stay.
describe("SignInAgainLink", () => {
  const html = renderToStaticMarkup(createElement(SignInAgainLink, { href: HREF }));

  it("opens in a new tab, without handing the opener to the new page", () => {
    expect(html).toMatch(/<a [^>]*target="_blank"/);
    expect(html).toMatch(/<a [^>]*rel="noopener noreferrer"/);
  });

  // Lead follow-up: the hint is visible too, and is part of the link's own
  // text, so the accessible name is what sighted users read (label in name).
  it("shows that it opens in a new tab, as part of the link's text", () => {
    expect(html).toMatch(/>Sign in to Google again <span class="[^"]*">\(opens in a new tab\)<\/span><\/a>/);
  });

  it("has no aria-label overriding the visible text", () => {
    expect(html).not.toContain("aria-label");
  });

  it("goes to the given start URL", () => {
    expect(html).toContain('href="/api/auth/google_business_profile/start?workspaceId=ws-1"');
  });

  // R26 pages L2: buttonVariants is whitespace-nowrap, so at 375 px the link ran
  // past the reply form. It wraps, and grows to fit its lines.
  it("wraps inside a narrow column instead of running past it", () => {
    const className = /<a [^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    const classes = className.split(" ");
    expect(classes).toContain("whitespace-normal");
    expect(classes).toContain("h-auto");
    expect(classes).toContain("text-left");
    expect(classes).toContain("flex-wrap");
    expect(classes).not.toContain("whitespace-nowrap");
    expect(classes).not.toContain("h-8");
  });

  it("the server's HTML is the new-tab link (the installed app is known only in the browser)", () => {
    expect(html).toContain("(opens in a new tab)");
  });
});

// R26 pages L3: in the installed app a new tab opens the browser, with other
// cookies and no session. There the sign-in opens in the same view, as the
// signed-out line's link does, and says to copy a typed reply first.
describe("SignInAgainLinkView in the installed app", () => {
  const html = renderToStaticMarkup(createElement(SignInAgainLinkView, { href: HREF, installed: true }));

  it("opens in the same view", () => {
    expect(html).not.toContain("target=");
    expect(html).toContain(`href="${HREF}"`);
  });

  it("says to copy a typed reply first, as part of the link's text", () => {
    expect(INSTALLED_APP_HINT).toBe("(you'll leave this page: copy any reply you typed first)");
    expect(html.replace(/&#x27;/g, "'")).toMatch(
      /<a [^>]*>Sign in to Google again <span class="[^"]*">\(you'll leave this page: copy any reply you typed first\)<\/span><\/a>/,
    );
    expect(html).not.toContain("new tab");
  });

  it("wraps like the new-tab link", () => {
    expect(html).toContain("whitespace-normal");
  });

  it("in a normal tab it is the new-tab link", () => {
    const tab = renderToStaticMarkup(createElement(SignInAgainLinkView, { href: HREF, installed: false }));
    expect(tab).toBe(renderToStaticMarkup(createElement(SignInAgainLink, { href: HREF })));
  });
});

describe("isInstalledApp", () => {
  const win = (standaloneMedia: boolean, navigatorStandalone?: boolean) =>
    ({
      matchMedia: (query: string) => ({ matches: standaloneMedia && query === "(display-mode: standalone)" }),
      navigator: navigatorStandalone === undefined ? {} : { standalone: navigatorStandalone },
      location: { pathname: "/reviews", search: "", hash: "" },
    }) as unknown as Window;

  it("follows the signed-out line's rule: display-mode standalone, or iOS's navigator.standalone", () => {
    expect(isInstalledApp(win(true))).toBe(true);
    expect(isInstalledApp(win(false, true))).toBe(true);
    expect(isInstalledApp(win(false, false))).toBe(false);
    expect(isInstalledApp(win(false))).toBe(false);
    expect(isInstalledApp(undefined)).toBe(false);
  });
});

// R26 pages L6: every new-tab link in these pages shows the same visible hint.
describe("NewTabHint", () => {
  it("is the visible hint the sign-in link uses", () => {
    const hint = renderToStaticMarkup(createElement(NewTabHint));
    expect(hint).toMatch(/^<span class="[^"]*">\(opens in a new tab\)<\/span>$/);
    expect(renderToStaticMarkup(createElement(SignInAgainLink, { href: HREF }))).toContain(hint);
  });
});
