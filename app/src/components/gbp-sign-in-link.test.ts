import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SignInAgainLink } from "./gbp-sign-in-link";

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
});
