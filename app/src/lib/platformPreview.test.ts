import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";
import { buildPlatformPreview } from "./platformPreview";
import { truncateGraphemes } from "./truncate";
import { computeGbpPostSummary } from "@/server/platforms/googleBusinessProfileClient";
import { computeTweetText } from "@/server/platforms/xClient";
import { fitPinterestDescription } from "./pinterestApi";
import { PLATFORM_CAPTION_LIMITS } from "./platformLimits";
import { trackedWebsiteLink } from "./trackingTags";

describe("buildPlatformPreview", () => {
  it("renders the plain caption for a null-limit platform with no footer/override", () => {
    const result = buildPlatformPreview({ platform: "linkedin", caption: "Hello world" });
    expect(result).toEqual({
      rendered: "Hello world",
      charCount: 11,
      limit: null,
      truncated: false,
      willTruncate: false,
    });
  });

  it("never shows a truncation warning for a null-limit platform, however long the caption", () => {
    const caption = "a".repeat(5000);
    for (const platform of ["youtube", "linkedin", "facebook_page"] as const) {
      const result = buildPlatformPreview({ platform, caption });
      expect(result.rendered).toBe(caption); // full caption, unmodified
      expect(result.limit).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.willTruncate).toBe(false);
    }
  });

  it("warns that Google Business Profile cuts a post at 1,500 characters, as the client does", () => {
    const caption = "a".repeat(5000);
    const result = buildPlatformPreview({ platform: "google_business_profile", caption });
    expect(result.limit).toBe(1500);
    expect(result.willTruncate).toBe(true);
    expect(result.rendered).toBe(`${"a".repeat(1497)}...`);
    expect(result.rendered).toBe(computeGbpPostSummary(caption));
  });

  it("shows an empty TikTok title when the caption is empty: no promotional default (2026-11)", () => {
    // Reuse-mode edge: whitespace-only override + no footer → empty footer-applied
    // caption. TikTok gets no substitute text (guideline 5b), so the preview is empty.
    const result = buildPlatformPreview({ platform: "tiktok", caption: "", override: "   " });
    expect(result.rendered).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.willTruncate).toBe(false);
  });

  it("does NOT substitute a default for other platforms on an empty caption (only TikTok does)", () => {
    const result = buildPlatformPreview({ platform: "x", caption: "" });
    expect(result.rendered).toBe("");
  });

  it("appends the user's footer (website + hashtags) the same way buildCaptionWithFooter does", () => {
    const user = { companyWebsite: "example.com", defaultHashtags: "#surf #lessons" };
    const result = buildPlatformPreview({ platform: "instagram", caption: "Check us out", user });
    expect(result.rendered).toBe(buildCaptionWithFooter("Check us out", user));
    expect(result.rendered).toBe(
      "Check us out\n\nFor more info visit example.com\n\n#surf #lessons",
    );
  });

  it("renders without a footer and without crashing when user is omitted", () => {
    const result = buildPlatformPreview({ platform: "instagram", caption: "No footer here" });
    expect(result.rendered).toBe("No footer here");
  });

  it("renders without a footer and without crashing when user is explicitly null", () => {
    const result = buildPlatformPreview({
      platform: "instagram",
      caption: "No footer here",
      user: null,
    });
    expect(result.rendered).toBe("No footer here");
  });

  it("prefers a non-empty per-platform override over the base caption", () => {
    const result = buildPlatformPreview({
      platform: "instagram",
      caption: "base caption",
      override: "override caption",
    });
    expect(result.rendered).toBe("override caption");
  });

  it("falls back to the base caption when override is an empty string (matches inngest-functions.ts truthiness check)", () => {
    const result = buildPlatformPreview({
      platform: "instagram",
      caption: "base caption",
      override: "",
    });
    expect(result.rendered).toBe("base caption");
  });

  it("falls back to the base caption when override is null/undefined", () => {
    expect(
      buildPlatformPreview({ platform: "instagram", caption: "base", override: null }).rendered,
    ).toBe("base");
    expect(
      buildPlatformPreview({ platform: "instagram", caption: "base" }).rendered,
    ).toBe("base");
  });

  it("honors a whitespace-only override verbatim, matching the real posting path's plain truthiness check", () => {
    // server/jobs/inngest-functions.ts does `captionOverride ? ... : fullBaseCaption`
    // with NO trim — a single space is truthy, so it IS used (then trimmed
    // internally by buildCaptionWithFooter's own baseCaption.trim()).
    const result = buildPlatformPreview({
      platform: "instagram",
      caption: "base caption",
      override: " ",
    });
    expect(result.rendered).toBe(buildCaptionWithFooter(" ", {}));
    expect(result.rendered).not.toBe(buildCaptionWithFooter("base caption", {}));
  });

  describe("X (charLimit 280, ellipsis '...')", () => {
    it("does not truncate a caption at or under 280 graphemes", () => {
      const caption = "a".repeat(280);
      const result = buildPlatformPreview({ platform: "x", caption });
      expect(result.rendered).toBe(caption);
      expect(result.limit).toBe(280);
      expect(result.charCount).toBe(280);
      expect(result.truncated).toBe(false);
      expect(result.willTruncate).toBe(false);
    });

    it("truncates a caption over 280 graphemes with a '...' ellipsis, matching truncateGraphemes directly", () => {
      const caption = "a".repeat(320);
      const result = buildPlatformPreview({ platform: "x", caption });
      expect(result.rendered).toBe(truncateGraphemes(caption, 280, { ellipsis: "..." }));
      expect(result.rendered).toHaveLength(280);
      expect(result.limit).toBe(280);
      expect(result.charCount).toBe(320); // pre-truncation count, NOT clamped to the limit
      expect(result.truncated).toBe(true);
      expect(result.willTruncate).toBe(true);
    });

    it("truncates the caption+footer COMBINED length, not the base caption alone", () => {
      // A base caption that alone fits, but overflows once the footer is
      // appended, must still be truncated — this is what actually happens
      // server-side (footer is appended BEFORE the client ever sees the text).
      const caption = "a".repeat(250);
      const user = { defaultHashtags: "#".repeat(60) };
      const result = buildPlatformPreview({ platform: "x", caption, user });
      const fullCaption = buildCaptionWithFooter(caption, user);
      expect(fullCaption.length).toBeGreaterThan(280);
      expect(result.rendered).toBe(truncateGraphemes(fullCaption, 280, { ellipsis: "..." }));
      expect(result.willTruncate).toBe(true);
    });
  });

  describe("TikTok (charLimit 2200, no ellipsis)", () => {
    it("does not truncate a caption at or under 2200 graphemes", () => {
      const caption = "a".repeat(2200);
      const result = buildPlatformPreview({ platform: "tiktok", caption });
      expect(result.rendered).toBe(caption);
      expect(result.limit).toBe(2200);
      expect(result.truncated).toBe(false);
      expect(result.willTruncate).toBe(false);
    });

    it("truncates a caption over 2200 graphemes with no ellipsis, matching truncateGraphemes directly", () => {
      const caption = "a".repeat(2500);
      const result = buildPlatformPreview({ platform: "tiktok", caption });
      expect(result.rendered).toBe(truncateGraphemes(caption, 2200));
      expect(result.rendered).toHaveLength(2200);
      expect(result.charCount).toBe(2500);
      expect(result.truncated).toBe(true);
      expect(result.willTruncate).toBe(true);
    });
  });

  describe("Instagram (charLimit 2200, no ellipsis — 2026-11-01 audit)", () => {
    it("does not truncate a caption at or under 2200 graphemes", () => {
      const caption = "a".repeat(2200);
      const result = buildPlatformPreview({ platform: "instagram", caption });
      expect(result.rendered).toBe(caption);
      expect(result.limit).toBe(2200);
      expect(result.willTruncate).toBe(false);
    });

    it("warns and truncates a caption over 2200 graphemes, matching truncateGraphemes directly", () => {
      const caption = "a".repeat(2500);
      const result = buildPlatformPreview({ platform: "instagram", caption });
      expect(result.rendered).toBe(truncateGraphemes(caption, 2200));
      expect(result.charCount).toBe(2500);
      expect(result.truncated).toBe(true);
      expect(result.willTruncate).toBe(true);
    });
  });

  it("keeps emoji/ZWJ sequences whole when truncating (delegates to truncateGraphemes, never slices mid-grapheme)", () => {
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(60);
    const result = buildPlatformPreview({ platform: "x", caption });
    expect(result.rendered).toBe(truncateGraphemes(caption, 280, { ellipsis: "..." }));
  });
});

// 20: with tracking tags on, the preview shows what will be sent: the tagged
// link when the whole text fits the platform's limit, the plain link when it
// does not. It agrees with the publish path (buildCaptionWithFooter with the
// platform, then the client's own cut) at the boundary too.
describe("buildPlatformPreview with tracking tags", () => {
  const off = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
  const on = { ...off, trackWebsiteLinks: true };
  const footerWith = (link: string) => `\n\nFor more info visit ${link}\n\n#surf`;
  const taggedFooter = (platform: "x" | "pinterest" | "google_business_profile") =>
    footerWith(trackedWebsiteLink("vibesurfschool.com", platform));
  const PLAIN = footerWith("vibesurfschool.com");

  it("shows X the tagged link when it fits, matching what the X client posts", () => {
    const result = buildPlatformPreview({ platform: "x", caption: "Waves", user: on });
    expect(result.rendered).toBe(`Waves${taggedFooter("x")}`);
    expect(result.rendered).toBe(computeTweetText(buildCaptionWithFooter("Waves", on, "x")));
  });

  it.each([
    ["x", (text: string) => computeTweetText(text)],
    ["google_business_profile", (text: string) => computeGbpPostSummary(text)],
    ["pinterest", (text: string) => fitPinterestDescription(text)],
  ] as const)("on %s: tagged one under and exactly at the limit, plain one over", (platform, send) => {
    const limit = PLATFORM_CAPTION_LIMITS[platform].charLimit as number;
    const room = limit - taggedFooter(platform).length;
    for (const [length, expectTagged] of [
      [room - 1, true],
      [room, true],
      [room + 1, false],
    ] as const) {
      const caption = "a".repeat(length);
      const preview = buildPlatformPreview({ platform, caption, user: on });
      const published = send(buildCaptionWithFooter(caption, on, platform));
      expect(preview.rendered).toBe(`${caption}${expectTagged ? taggedFooter(platform) : PLAIN}`);
      expect(preview.rendered).toBe(published);
      expect(preview.willTruncate).toBe(false);
    }
  });

  it("on X decides on the text without @-mentions, as the X client counts it", () => {
    const room = 280 - taggedFooter("x").length;
    // With the mention the tagged text is over 280; without it, it fits exactly.
    const caption = `@ana_surf ${"a".repeat(room)}`;
    const preview = buildPlatformPreview({ platform: "x", caption, user: on });
    expect(preview.rendered).toBe(`${"a".repeat(room)}${taggedFooter("x")}`);
    expect(preview.rendered).toBe(computeTweetText(buildCaptionWithFooter(caption, on, "x")));
  });

  it("a long caption that does not fit is cut as with the setting off, never inside the link", () => {
    const caption = "a".repeat(400);
    const tagged = buildPlatformPreview({ platform: "x", caption, user: on });
    expect(tagged).toEqual(buildPlatformPreview({ platform: "x", caption, user: off }));
    expect(tagged.rendered).not.toContain("utm_");
  });

  it("uses a per-platform caption with that platform's own tagged footer", () => {
    const result = buildPlatformPreview({
      platform: "linkedin",
      caption: "Main",
      override: "Own LinkedIn text",
      user: on,
    });
    expect(result.rendered).toBe(buildCaptionWithFooter("Own LinkedIn text", on, "linkedin"));
    expect(result.rendered).toContain("utm_source=linkedin");
  });

  it("leaves Instagram untagged and every platform as today with the setting off", () => {
    expect(buildPlatformPreview({ platform: "instagram", caption: "Waves", user: on }).rendered).toBe(
      buildCaptionWithFooter("Waves", off),
    );
    for (const platform of ["x", "linkedin", "facebook_page", "pinterest"] as const) {
      expect(buildPlatformPreview({ platform, caption: "Waves", user: off }).rendered).toBe(
        buildCaptionWithFooter("Waves", off),
      );
    }
  });
});
