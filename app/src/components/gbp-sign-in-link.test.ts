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

  it("says it opens in a new tab, and keeps its visible words", () => {
    expect(html).toMatch(/<a [^>]*aria-label="Sign in to Google again \(opens in a new tab\)"/);
    expect(html).toMatch(/>Sign in to Google again<\/a>/);
  });

  it("goes to the given start URL", () => {
    expect(html).toContain('href="/api/auth/google_business_profile/start?workspaceId=ws-1"');
  });
});
