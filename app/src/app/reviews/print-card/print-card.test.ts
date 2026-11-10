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
