import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import NotFound, { metadata } from "./not-found";

// R5 pages L11: the 404 names the tab, has a page heading, and its button
// suits a signed-out visitor as well as a signed-in one.
describe("404 page", () => {
  it("names the tab", () => {
    expect(metadata.title).toBe("Page not found | Vibe Socials");
  });

  it("has an h1 and a way back that does not assume a dashboard", () => {
    const html = renderToStaticMarkup(NotFound() as ReactElement);
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to Vibe Socials<\/a>/);
    expect(html).not.toContain("dashboard");
  });
});
