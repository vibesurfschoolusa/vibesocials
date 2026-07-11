import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";
import { buildPlatformPreview } from "./platformPreview";
import { truncateGraphemes } from "./truncate";

describe("buildPlatformPreview", () => {
  it("renders the plain caption for a null-limit platform with no footer/override", () => {
    const result = buildPlatformPreview({ platform: "instagram", caption: "Hello world" });
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
    for (const platform of [
      "youtube",
      "instagram",
      "linkedin",
      "facebook_page",
      "google_business_profile",
    ] as const) {
      const result = buildPlatformPreview({ platform, caption });
      expect(result.rendered).toBe(caption); // full caption, unmodified
      expect(result.limit).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.willTruncate).toBe(false);
    }
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

  it("keeps emoji/ZWJ sequences whole when truncating (delegates to truncateGraphemes, never slices mid-grapheme)", () => {
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(60);
    const result = buildPlatformPreview({ platform: "x", caption });
    expect(result.rendered).toBe(truncateGraphemes(caption, 280, { ellipsis: "..." }));
  });
});
