import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExternalLink, NEW_TAB_HINT } from "./external-link";

/**
 * R26 pages L6: a link that opens a new tab says so where everyone can see it
 * (the #191 sign-in link does), as part of its name. One component, so every
 * such link says it the same way.
 */
describe("ExternalLink", () => {
  const html = renderToStaticMarkup(
    createElement(ExternalLink, { href: "https://example.com/help", className: "underline" }, "How to connect"),
  );

  it("opens a new tab without handing this page to it", () => {
    expect(html).toContain('href="https://example.com/help"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('class="underline"');
  });

  it("the visible hint is part of the link's text, and not printed", () => {
    expect(NEW_TAB_HINT).toBe("(opens in a new tab)");
    expect(html).toMatch(/^<a [^>]*>How to connect <span class="[^"]*print:hidden[^"]*">\(opens in a new tab\)<\/span><\/a>$/);
    expect(html).not.toContain("sr-only");
  });
});

const CALLERS = [
  "./connections-section.tsx",
  "./linkedin-setup-dialog.tsx",
  "./reports/monthly-report.tsx",
  "./activity/post-job-card.tsx",
  "../app/help/page.tsx",
  "../app/terms/page.tsx",
];

describe("new-tab links use ExternalLink", () => {
  for (const path of CALLERS) {
    it(path, () => {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      expect(source).toContain("<ExternalLink");
      expect(source).not.toContain('target="_blank"');
    });
  }
});
