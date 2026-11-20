import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { STORY_NO_CAPTION } from "@/lib/storyPlacement";

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

// R48 publishing L3: a platform set to Story only publishes no caption, so its
// tab shows "Story, no caption" with no count and no over-limit mark.
describe("PlatformPreviewList with a Story-only platform", () => {
  const long = "a".repeat(2_300);
  const renderWith = (storyOnly: Platform[], platforms: Platform[] = ["instagram"]) =>
    renderToStaticMarkup(
      createElement(PlatformPreviewList, {
        platforms,
        caption: long,
        mediaUrl: "blob:cover",
        mediaMimeType: "image/jpeg",
        storyOnly,
      }),
    );

  it("Instagram Story only: Story, no caption, with no count and no over-limit mark", () => {
    const html = renderWith(["instagram"]);
    expect(html).toContain(STORY_NO_CAPTION);
    expect(html).not.toContain("characters");
    expect(html).not.toContain("Will be shortened");
    expect(html).not.toContain(long);
  });

  it("the Story-only tab carries no over-limit mark; the other tabs keep theirs", () => {
    const html = renderWith(["instagram"], ["instagram", "x"]);
    expect(html).not.toContain("Instagram, over its limit");
    expect(html).toContain("X, over its limit");
  });

  it("Feed and Story (not Story only) and Story switched off: the caption and its count", () => {
    const html = renderWith([]);
    expect(html).not.toContain(STORY_NO_CAPTION);
    expect(html).toContain("/ 2200 characters");
    expect(html).toContain("Will be shortened");
  });
});
