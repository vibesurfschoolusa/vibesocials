import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { qrSvg } from "@/lib/qrSvg";

import { PrintCard } from "./print-card";

const LINK = "https://g.page/r/abc/review";

describe("PrintCard", () => {
  it("shows the business name, the line to scan and the QR code", () => {
    const html = renderToStaticMarkup(createElement(PrintCard, { businessName: "Surf & Co", url: LINK }));

    expect(html).toContain("Surf &amp; Co");
    expect(html).toContain("Scan to review us on Google");
    expect(html).toContain(qrSvg(LINK));
    expect(html).toContain("Print");
  });

  it("says how to get a link when there is none yet", () => {
    const html = renderToStaticMarkup(createElement(PrintCard, { businessName: "Surf Co", url: null }));

    expect(html).not.toContain("<svg");
    expect(html).toContain("Open the Reviews page");
  });
});

// R13-pages L1: without a link the page still has a heading and a way back to Reviews.
describe("PrintCard without a saved review link", () => {
  it("has an h1 and links to /reviews", () => {
    const html = renderToStaticMarkup(createElement(PrintCard, { businessName: "Surf Co", url: null }));

    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toMatch(/<a [^>]*href="\/reviews"[^>]*>Open the Reviews page<\/a>/);
  });
});
