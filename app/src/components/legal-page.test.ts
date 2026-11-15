import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalPage } from "./legal-page";

// R5 pages L13: the legal and about pages sit in a main landmark.
describe("LegalPage", () => {
  it("puts the page in a main landmark", () => {
    const html = renderToStaticMarkup(createElement(LegalPage, { title: "Terms", children: "Body" }));
    expect(html).toMatch(/^<main[ >]/);
  });
});
