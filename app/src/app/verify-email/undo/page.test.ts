import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import UndoPage, { metadata } from "./page";
import { UndoClient } from "./undo-client";

describe("undo email change page", () => {
  it("names the tab and sits in a main landmark", () => {
    expect(metadata.title).toBe("Undo the email change | Vibe Socials");
    expect(renderToStaticMarkup(UndoPage() as ReactElement)).toMatch(/<main[ >]/);
  });

  // A mail scanner opening the link must not undo anything.
  it("waits for a press of the button and never posts on load", () => {
    const html = renderToStaticMarkup(createElement(UndoClient));
    expect(html).toMatch(/<button[^>]*>(<[^>]+>)*Undo the change/);
    expect(readFileSync(join(__dirname, "undo-client.tsx"), "utf8")).not.toContain("useEffect");
  });
});
