import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GettingStarted } from "./getting-started";

/** S1 item 1: the first step says which platforms connect right away today. */

const OFFERED = ["tiktok", "youtube", "instagram", "x", "linkedin", "facebook_page", "google_business_profile"] as const;

describe("GettingStarted", () => {
  it("with nothing connected, names the platforms that connect right away and links the guide", () => {
    const html = renderToStaticMarkup(
      createElement(GettingStarted, { connections: [], jobs: [], availablePlatforms: OFFERED }),
    );
    expect(html).toContain("YouTube and X connect right away today; the others are explained in the");
    expect(html).toMatch(/<a [^>]*href="\/help"[^>]*>setup guide<\/a>\./);
  });

  it("names Pinterest only where this site offers it", () => {
    const html = renderToStaticMarkup(
      createElement(GettingStarted, { connections: [], jobs: [], availablePlatforms: [...OFFERED, "pinterest"] }),
    );
    expect(html).toContain("YouTube, X and Pinterest connect right away today");
  });
});
