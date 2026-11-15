import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalPage } from "./legal-page";

// R5 pages L13: the legal and about pages sit in a main landmark.
describe("LegalPage", () => {
  it("puts the page in a main landmark", () => {
    // Called as a plain function (it uses no hooks), so its required children go in its props.
    const html = renderToStaticMarkup(LegalPage({ title: "Terms", children: "Body" }) as ReactElement);
    expect(html).toMatch(/^<main[ >]/);
  });
});
