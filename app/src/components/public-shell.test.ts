import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContext } from "next-auth/react";
import { describe, expect, it } from "vitest";

import { PublicHeader } from "./public-shell";

// R17-pages L1: a signed-in owner was offered "Log in" in the public header.
type Session = Parameters<typeof SessionContext.Provider>[0]["value"];
const signedIn: Session = {
  status: "authenticated",
  data: { user: { name: "Owner", email: "owner@example.com" }, expires: "2099-01-01T00:00:00Z" },
  update: async () => null,
};

function render(element: ReactElement, session?: Session): string {
  return renderToStaticMarkup(
    session ? createElement(SessionContext.Provider, { value: session }, element) : element,
  );
}

describe("PublicHeader", () => {
  it("offers Log in when signed out, also with no session provider", () => {
    const html = render(createElement(PublicHeader, { showPricing: true }));
    expect(html).toMatch(/<a [^>]*href="\/login"[^>]*>Log in<\/a>/);
    expect(html).not.toContain(">Dashboard<");
  });

  it("offers Log in while the session is still loading (the server's HTML)", () => {
    const html = render(createElement(PublicHeader, { showPricing: true }), {
      status: "loading",
      data: undefined,
      update: async () => null,
    } as unknown as Session);
    expect(html).toContain(">Log in</a>");
  });

  // Short like "Log in": the nav's buttons don't wrap, and a longer label made
  // the header wider than a 375 px phone beside Pricing and About.
  it("offers only Dashboard to a signed-in visitor", () => {
    const html = render(createElement(PublicHeader, { showPricing: true }), signedIn);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Dashboard<\/a>/);
    expect(html).not.toContain("Log in");
    expect(html).not.toContain('href="/login"');
  });

  it("offers Dashboard when the server already knows the visitor is signed in", () => {
    const html = render(createElement(PublicHeader, { showPricing: true, signedIn: true }));
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Dashboard<\/a>/);
    expect(html).not.toContain("Log in");
  });
});
