import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorState } from "./error-state";

const render = (props: { message: string; settingsLink?: boolean; isMember?: boolean; signInUrl?: string }) =>
  renderToStaticMarkup(
    createElement(ErrorState, { title: "Couldn't load reviews", onRetry: () => {}, ...props, isMember: props.isMember ?? false }),
  );

// F7 (R1 M5): a refused Google request offers the way to reconnect.
describe("ErrorState", () => {
  it("links to the connections in Settings when asked to", () => {
    const html = render({ message: "Google refused the request.", settingsLink: true });

    // JJ3 lead review: straight to the Google Business Profile card.
    expect(html).toMatch(/<a [^>]*href="\/settings#google-business-profile"[^>]*>Go to Settings/);
  });

  it("has no Settings link for an error a retry can fix", () => {
    expect(render({ message: "Couldn't load your Google reviews." })).not.toContain("/settings");
  });

  it("still links for the not-configured message", () => {
    expect(render({ message: "AI is not configured" })).toContain('href="/settings#connections"');
  });
});

// JJ3 lead review: the in-place sign-in is a link to the Reconnect button's start URL.
describe("ErrorState: signing in to Google again", () => {
  it("an owner gets a Sign in to Google again link to the start URL", () => {
    const html = render({ message: "Google didn't accept the connection.", settingsLink: true, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-1" });
    expect(html).toMatch(/<a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-1"[^>]*>Sign in to Google again<\/a>/);
  });

  it("a member never does", () => {
    const html = render({ message: "x", settingsLink: true, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-1", isMember: true });
    expect(html).not.toContain("/api/auth/");
  });
});

// R12 L1: a member can't reconnect (Settings is read-only for them), so no link.
describe("ErrorState for a member", () => {
  it("has no Settings link, even when asked for one or for the not-configured message", () => {
    expect(render({ message: "Google refused the request.", settingsLink: true, isMember: true })).not.toContain(
      "/settings",
    );
    expect(render({ message: "AI is not configured", isMember: true })).not.toContain("/settings");
  });

  it("still offers Retry", () => {
    expect(render({ message: "Couldn't load your Google reviews.", isMember: true })).toContain(">Retry<");
  });
});
