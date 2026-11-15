import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorState } from "./error-state";

const render = (props: { message: string; settingsLink?: boolean }) =>
  renderToStaticMarkup(createElement(ErrorState, { title: "Couldn't load reviews", onRetry: () => {}, ...props }));

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
