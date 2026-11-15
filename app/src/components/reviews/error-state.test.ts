import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorState } from "./error-state";

const render = (props: { message: string; settingsLink?: boolean; isMember?: boolean }) =>
  renderToStaticMarkup(
    createElement(ErrorState, { title: "Couldn't load reviews", onRetry: () => {}, ...props, isMember: props.isMember ?? false }),
  );

// F7 (R1 M5): a refused Google request offers the way to reconnect.
describe("ErrorState", () => {
  it("links to the connections in Settings when asked to", () => {
    const html = render({ message: "Google refused the request.", settingsLink: true });

    expect(html).toMatch(/<a [^>]*href="\/settings#connections"[^>]*>Go to Settings/);
  });

  it("has no Settings link for an error a retry can fix", () => {
    expect(render({ message: "Couldn't load your Google reviews." })).not.toContain("/settings");
  });

  it("still links for the not-configured message", () => {
    expect(render({ message: "AI is not configured" })).toContain('href="/settings#connections"');
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
