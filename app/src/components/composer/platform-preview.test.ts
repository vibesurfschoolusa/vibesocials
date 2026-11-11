import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlatformPreviewList } from "./platform-preview";

const render = (mediaCount?: number) =>
  renderToStaticMarkup(
    createElement(PlatformPreviewList, {
      platforms: ["instagram"],
      caption: "hello",
      mediaUrl: "blob:cover",
      mediaMimeType: "image/jpeg",
      mediaCount,
    }),
  );

describe("PlatformPreviewList photo count", () => {
  it("shows the first photo with no badge for one photo", () => {
    expect(render()).toContain('src="blob:cover"');
    expect(render()).not.toContain("photos");
    expect(render(1)).toBe(render());
  });

  it("shows a count badge for several photos", () => {
    const html = render(4);
    expect(html).toContain('src="blob:cover"');
    expect(html).toContain('aria-label="4 photos"');
    expect(html).toContain(">4</span>");
  });
});

// Go-live check F2 item 4: a long footer link ran past the card on a phone.
describe("PlatformPreviewList long text", () => {
  it("wraps the preview text anywhere, so a long link stays inside its card", () => {
    const link = "https://example.com/?utm_source=facebook&utm_medium=social&utm_campaign=vibesocials";
    for (const platform of ["instagram", "facebook_page", "x", "linkedin", "tiktok", "youtube", "google_business_profile"] as const) {
      const html = renderToStaticMarkup(
        createElement(PlatformPreviewList, { platforms: [platform], caption: link, mediaUrl: null, mediaMimeType: null }),
      );
      const text = html.match(/<p class="([^"]*)">[^<]*utm_campaign/)?.[1] ?? "";
      expect(text, platform).toContain("[overflow-wrap:anywhere]");
      // The card itself may shrink to its column instead of growing to the link.
      expect(html.match(/role="group"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*role="group"/)?.slice(1).join(" "), platform).toContain(
        "min-w-0",
      );
    }
  });
});
