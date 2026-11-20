import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";
import { buildPlatformPreview, type PlatformPreviewInput } from "./platformPreview";
import { truncateGraphemes } from "./truncate";
import { computeGbpPostSummary } from "@/server/platforms/googleBusinessProfileClient";
import { computeInstagramCaption } from "@/server/platforms/instagramClient";
import { computeLinkedInCommentary } from "@/server/platforms/linkedinClient";
import { computeTikTokCaption } from "@/server/platforms/tiktokClient";
import { computeTweetText } from "@/server/platforms/xClient";
import type { PublishContext } from "@/server/platforms/types";
import { buildYouTubeVideoResource, computeYouTubeTitle } from "@/server/platforms/youtubeClient";
import { fitYouTubeDescription, youtubeDescriptionLength } from "./youtubeDescription";
import { fitPinterestDescription } from "./pinterestApi";
import { PLATFORM_CAPTION_LIMITS } from "./platformLimits";
import { trackedWebsiteLink } from "./trackingTags";

describe("buildPlatformPreview", () => {
  it("renders the plain caption for a null-limit platform with no footer/override", () => {
    const result = buildPlatformPreview({ platform: "facebook_page", caption: "Hello world" });
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
    for (const platform of ["facebook_page"] as const) {
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

    // Fix round 1 (M5): the footer goes before the caption is cut, as at publish.
    it("drops the footer, not the caption, when caption + footer is over", () => {
      const caption = "a".repeat(250);
      const user = { defaultHashtags: "#".repeat(60) };
      const result = buildPlatformPreview({ platform: "x", caption, user });
      expect(buildCaptionWithFooter(caption, user).length).toBeGreaterThan(280);
      expect(result.rendered).toBe(caption);
      expect(result.rendered).toBe(computeTweetText(buildCaptionWithFooter(caption, user, "x")));
      expect(result.willTruncate).toBe(false);
    });

    it("counts and cuts by X's weight: an emoji 2", () => {
      const caption = "\u{1F30A}".repeat(200);
      const result = buildPlatformPreview({ platform: "x", caption });
      expect(result.charCount).toBe(400);
      expect(result.willTruncate).toBe(true);
      expect(result.rendered).toBe(computeTweetText(caption));
      expect(result.rendered).toBe("\u{1F30A}".repeat(138) + "...");
    });

    it("counts a long link as 23 and does not cut it", () => {
      const caption = "a".repeat(250) + " https://vibesurfschool.com/lessons/fort-lauderdale/private-surf-lessons";
      const result = buildPlatformPreview({ platform: "x", caption });
      expect(result.charCount).toBe(274);
      expect(result.rendered).toBe(caption);
      expect(result.willTruncate).toBe(false);
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

    // R5-publishing L2: the footer goes whole, as at publish, instead of being
    // cut inside its link or a hashtag.
    it("drops the footer, not the caption, when caption + footer is over", () => {
      const caption = "a".repeat(2190);
      const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #miami" };
      const result = buildPlatformPreview({ platform: "instagram", caption, user });
      expect(result.rendered).toBe(caption);
      expect(result.rendered).toBe(computeInstagramCaption(buildCaptionWithFooter(caption, user, "instagram")));
      expect(result.willTruncate).toBe(false);
    });
  });

  it.each(["tiktok", "google_business_profile", "pinterest"] as const)(
    "%s: a long caption loses the footer whole and is never cut inside its link",
    (platform) => {
      const limit = PLATFORM_CAPTION_LIMITS[platform].charLimit as number;
      const caption = "a".repeat(limit - 20);
      const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
      const result = buildPlatformPreview({ platform, caption, user });
      expect(result.rendered).toBe(caption);
      expect(result.willTruncate).toBe(false);
    },
  );

  it("keeps emoji/ZWJ sequences whole when truncating (delegates to truncateGraphemes, never slices mid-grapheme)", () => {
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(60);
    const result = buildPlatformPreview({ platform: "x", caption });
    expect(result.rendered).toBe(computeTweetText(caption));
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

  it("on x: tagged at the limit; one over drops the hashtags and keeps the tagged link", () => {
    // On X the tagged link weighs 23, the same as the plain one.
    const room = 280 - 52; // "For more info visit " 20 + link 23 + "#surf" 5 + two blank lines 4
    for (const [length, footer] of [
      [room, taggedFooter("x")],
      [room + 1, taggedFooter("x").replace("\n\n#surf", "")],
    ] as const) {
      const caption = "a".repeat(length);
      const preview = buildPlatformPreview({ platform: "x", caption, user: on });
      expect(preview.rendered).toBe(`${caption}${footer}`);
      expect(preview.rendered).toBe(computeTweetText(buildCaptionWithFooter(caption, on, "x")));
      expect(preview.willTruncate).toBe(false);
    }
  });

  it.each([
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

// Go-live check 2026-11-11: with nothing typed, the LinkedIn, Facebook and
// Google previews began with an empty line and a blank line, then the footer.
describe("buildPlatformPreview — empty caption", () => {
  const footer = { companyWebsite: "www.example.com", defaultHashtags: "#surf #school" };

  it.each(["linkedin", "facebook_page", "google_business_profile", "instagram", "x"] as const)(
    "%s shows the footer alone",
    (platform) => {
      expect(buildPlatformPreview({ platform, caption: "", user: footer }).rendered).toBe(
        "For more info visit www.example.com\n\n#surf #school",
      );
      expect(buildPlatformPreview({ platform, caption: "  \n ", user: footer }).rendered).toBe(
        "For more info visit www.example.com\n\n#surf #school",
      );
    },
  );

  it("with a caption, shows exactly what it showed before", () => {
    expect(buildPlatformPreview({ platform: "linkedin", caption: "Dawn patrol", user: footer }).rendered).toBe(
      "Dawn patrol\n\nFor more info visit www.example.com\n\n#surf #school",
    );
  });

  it("with no footer and no caption, stays empty", () => {
    expect(buildPlatformPreview({ platform: "linkedin", caption: "", user: {} }).rendered).toBe("");
  });
});

// Fix round 1 (M6): LinkedIn's 3,000 limit, footer first, as the client cuts it.
describe("buildPlatformPreview on LinkedIn", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };

  it("shows a 3,100-character post cut at 3,000 with the footer dropped first", () => {
    const caption = "a".repeat(3100);
    const result = buildPlatformPreview({ platform: "linkedin", caption, user });
    expect(result.limit).toBe(3000);
    expect(result.willTruncate).toBe(true);
    expect(result.rendered).toBe("a".repeat(2997) + "...");
    expect(result.rendered).toBe(computeLinkedInCommentary(buildCaptionWithFooter(caption, user, "linkedin")));
  });

  it("keeps a link whole at the cut, as the client does", () => {
    const caption = "w".repeat(2990) + " https://vibesurfschool.com/lessons/fort-lauderdale/private-surf-lessons";
    const result = buildPlatformPreview({ platform: "linkedin", caption });
    expect(result.rendered).toBe("w".repeat(2990) + " ...");
    expect(result.rendered).toBe(computeLinkedInCommentary(caption));
  });

  it("leaves a post under the limit unchanged", () => {
    const result = buildPlatformPreview({ platform: "linkedin", caption: "Waves", user });
    expect(result.rendered).toBe("Waves\n\nFor more info visit vibesurfschool.com\n\n#surf");
    expect(result.willTruncate).toBe(false);
  });
});

// R52 platform-clients L1: YouTube cuts the description, footer included, at
// 5,000 UTF-8 bytes. The preview shows the very text the client posts.
describe("buildPlatformPreview on YouTube", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const posted = (caption: string, baseCaption = caption) =>
    buildYouTubeVideoResource({
      caption: buildCaptionWithFooter(caption, user, "youtube"),
      baseCaption,
      mediaItem: { baseCaption },
    } as unknown as PublishContext).metadata.snippet;

  it.each([
    [4999, false],
    [5000, false],
    [5001, true],
  ] as const)("ASCII %i long: willTruncate %s, as the client cuts", (length, cut) => {
    const caption = "a".repeat(length);
    const result = buildPlatformPreview({ platform: "youtube", caption });
    expect(result.willTruncate).toBe(cut);
    expect(result.truncated).toBe(cut);
    expect(result.byteCount).toBe(length);
    expect(result.byteLimit).toBe(5000);
    expect(result.rendered).toBe(fitYouTubeDescription(caption));
    expect(result.rendered).toBe(cut ? `${"a".repeat(4997)}…` : caption);
  });

  it("warns for a short description whose emoji pass 5,000", () => {
    const caption = "Waves \u{1F30A}".repeat(500); // 4,000 UTF-16 units, 5,000 counted
    const result = buildPlatformPreview({ platform: "youtube", caption: `${caption}!` });
    expect(result.byteCount).toBe(5001);
    expect(result.willTruncate).toBe(true);
    expect(result.rendered.endsWith("…")).toBe(true);
    expect(youtubeDescriptionLength(result.rendered)).toBeLessThanOrEqual(5000);
  });

  it("warns when the footer pushes it over, and the cut takes the footer", () => {
    const caption = "a".repeat(4950);
    const full = buildCaptionWithFooter(caption, user, "youtube");
    expect(full.length).toBeGreaterThan(5000);
    expect(buildPlatformPreview({ platform: "youtube", caption }).willTruncate).toBe(false);
    const result = buildPlatformPreview({ platform: "youtube", caption, user });
    expect(result.willTruncate).toBe(true);
    expect(result.byteCount).toBe(youtubeDescriptionLength(full));
    expect(result.rendered).toBe(posted(caption).description);
    expect(result.rendered).not.toContain("#surf");
  });

  it("shows < and > as the client sends them, counted after the swap", () => {
    const result = buildPlatformPreview({ platform: "youtube", caption: "I <3 surfing -> book now" });
    expect(result.rendered).toBe("I ‹3 surfing -› book now");
    expect(result.byteCount).toBe(28);
    expect(result.truncated).toBe(false);
    expect(result.willTruncate).toBe(false);
    const many = buildPlatformPreview({ platform: "youtube", caption: "<".repeat(2000) });
    expect(many.willTruncate).toBe(true);
    expect(many.rendered).toBe(fitYouTubeDescription("<".repeat(2000)));
  });

  it.each([
    "Dawn patrol \u{1F30A} <3 café",
    "a".repeat(4950),
    "Glassy waves é ".repeat(400),
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} ".repeat(300),
  ])("renders exactly what the client posts as the description (%#)", (caption) => {
    const result = buildPlatformPreview({ platform: "youtube", caption, user });
    expect(result.rendered).toBe(posted(caption).description);
    expect(result.willTruncate).toBe(youtubeDescriptionLength(buildCaptionWithFooter(caption, user, "youtube")) > 5000);
  });

  it("keeps the title a separate field: the base caption fitted to 100 characters, unchanged", () => {
    const caption = "Morning glass at Las Olas <3 ".repeat(300);
    const { title } = posted(caption);
    expect(title).toBe(computeYouTubeTitle({ caption, baseCaption: caption, mediaItem: { baseCaption: caption } }));
    expect([...title].length).toBeLessThanOrEqual(100);
    expect(title).toContain("‹3");
    expect(buildPlatformPreview({ platform: "youtube", caption }).rendered).not.toBe(title);
  });
});

// R52: the YouTube change leaves every other platform's preview as it was.
// Values pinned from main f796e2e.
describe("buildPlatformPreview on other platforms, unchanged by YouTube's byte limit", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);
  const tagged = (source: string) =>
    `vibesurfschool.com/?utm_source=${source}&utm_medium=social&utm_campaign=vibesocials`;
  const footer = (link: string) => `\n\nFor more info visit ${link}\n\n#surf #waves`;

  it.each([
    ["x", footer(tagged("x")), 198, 280, [280, 3749, true]],
    ["instagram", footer("vibesurfschool.com"), 189, 2200, [2200, 3749, true]],
    ["linkedin", footer(tagged("linkedin")), 253, 3000, [3000, 3749, true]],
    ["facebook_page", footer(tagged("facebook")), 253, null, [3867, 3867, false]],
    ["google_business_profile", footer(tagged("google")), 251, 1500, [1500, 3749, true]],
  ] as const)("%s", (platform, footerText, count, limit, [longLength, longCount, longCut]) => {
    expect(buildPlatformPreview({ platform, caption: short, user })).toEqual({
      rendered: `${short}${footerText}`,
      charCount: count,
      limit,
      truncated: false,
      willTruncate: false,
    });
    const result = buildPlatformPreview({ platform, caption: long, user });
    expect(Object.keys(result).sort()).toEqual(["charCount", "limit", "rendered", "truncated", "willTruncate"]);
    expect(result.rendered.length).toBe(longLength);
    expect(result).toMatchObject({ charCount: longCount, limit, truncated: longCut, willTruncate: longCut });
  });
});

// R53 platform-clients L1: Pinterest cuts the description while it is over 800
// code points (fitPinterestDescription), so the preview counts code points and
// shows the text that function makes. A heart, a flag or a skin tone is one
// character on screen and 2 code points; a family of four is 7.
describe("buildPlatformPreview on Pinterest", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf", trackWebsiteLinks: true };
  const HINT = "Pinterest counts some emoji and accented letters as 2 or more.";
  const codePoints = (text: string) => [...text].length;
  const posted = (caption: string, footer: PlatformPreviewInput["user"] = null) =>
    fitPinterestDescription(buildCaptionWithFooter(caption, footer ?? {}, "pinterest"));

  it.each([
    [799, false],
    [800, false],
    [801, true],
  ] as const)("ASCII %i long: willTruncate %s, rendered as the client posts", (length, cut) => {
    const caption = "a".repeat(length);
    const result = buildPlatformPreview({ platform: "pinterest", caption });
    expect(result).toEqual({
      rendered: posted(caption),
      charCount: length,
      limit: 800,
      truncated: cut,
      willTruncate: cut,
    });
    expect(result.rendered).toBe(cut ? `${"a".repeat(797)}...` : caption);
  });

  it("reads the finding's 760 characters with 50 hearts as 810 / 800, and cut", () => {
    const caption = `${"a".repeat(710)}${"❤️".repeat(50)}`;
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(caption)].length).toBe(760);
    const result = buildPlatformPreview({ platform: "pinterest", caption });
    expect(result.charCount).toBe(810);
    expect(result.willTruncate).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.rendered).toBe(posted(caption));
    expect(codePoints(result.rendered)).toBeLessThanOrEqual(800);
    expect(result.countHint).toBe(HINT);
  });

  it.each([
    ["a heart", "❤️", 2],
    ["a flag", "\u{1F1FA}\u{1F1F8}", 2],
    ["a skin tone", "\u{1F44B}\u{1F3FD}", 2],
    ["a family", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}", 7],
  ] as const)("%s around 800: whole at 800 code points, cut one over", (_name, emoji, size) => {
    const count = Math.floor(780 / size);
    const at = `${emoji.repeat(count)}${"a".repeat(800 - count * size)}`;
    const over = `${at}a`;
    expect(codePoints(at)).toBe(800);
    const whole = buildPlatformPreview({ platform: "pinterest", caption: at });
    expect(whole).toMatchObject({ rendered: at, charCount: 800, truncated: false, willTruncate: false, countHint: HINT });
    expect(posted(at)).toBe(at);
    const cut = buildPlatformPreview({ platform: "pinterest", caption: over });
    expect(cut).toMatchObject({ charCount: 801, truncated: true, willTruncate: true, countHint: HINT });
    expect(cut.rendered).toBe(posted(over));
    expect(cut.rendered.endsWith("...")).toBe(true);
  });

  it("counts the footer it posts, and drops the footer as the publish path does", () => {
    const fits = buildPlatformPreview({ platform: "pinterest", caption: "Waves ❤️", user });
    const full = buildCaptionWithFooter("Waves ❤️", user, "pinterest");
    expect(fits.rendered).toBe(full);
    expect(fits.charCount).toBe(codePoints(full));
    // 390 hearts: 390 characters, 780 code points. With the footer the text
    // is over 800 code points, so the footer goes and the caption is whole.
    const hearts = "❤️".repeat(390);
    const dropped = buildPlatformPreview({ platform: "pinterest", caption: hearts, user });
    expect(dropped.rendered).toBe(hearts);
    expect(dropped.rendered).toBe(posted(hearts, user));
    expect(dropped).toMatchObject({ charCount: 780, willTruncate: false, truncated: false });
  });

  it("gives the hint only when something counts as more than one", () => {
    expect(buildPlatformPreview({ platform: "pinterest", caption: "Plain words, no marks" })).not.toHaveProperty(
      "countHint",
    );
    // A precomposed é is one code point: no jump, no hint.
    expect(buildPlatformPreview({ platform: "pinterest", caption: "Café" })).not.toHaveProperty("countHint");
    expect(buildPlatformPreview({ platform: "pinterest", caption: "Café" }).countHint).toBe(HINT);
    expect(buildPlatformPreview({ platform: "pinterest", caption: "Waves \u{1F30A}" })).not.toHaveProperty("countHint");
    expect(buildPlatformPreview({ platform: "pinterest", caption: "Love ❤️" }).countHint).toBe(HINT);
  });
});

// R53: on every platform, non-ASCII text (emoji, a joined family, flags,
// accented letters, a combining mark) is shown exactly as the platform's own
// client posts it, and "will be shortened" is true exactly when that client cuts.
describe("buildPlatformPreview and every client agree on non-ASCII text", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #café", trackWebsiteLinks: true };
  const send: Record<Exclude<PlatformPreviewInput["platform"], "youtube">, (text: string) => string> = {
    x: computeTweetText,
    tiktok: computeTikTokCaption,
    instagram: computeInstagramCaption,
    linkedin: computeLinkedInCommentary,
    facebook_page: (text) => text,
    google_business_profile: computeGbpPostSummary,
    pinterest: fitPinterestDescription,
  };
  const pieces = [
    "❤️",
    "\u{1F30A}",
    "\u{1F468}‍\u{1F469}‍\u{1F467}",
    "\u{1F1FA}\u{1F1F8}",
    "\u{1F44B}\u{1F3FD}",
    "café",
    "é",
    "ñandú",
  ];
  const texts = (limit: number) =>
    pieces.flatMap((piece) => {
      const unit = `${piece} `;
      const near = Math.floor(limit / [...unit].length);
      return [unit.repeat(Math.max(1, near - 30)), unit.repeat(near), unit.repeat(near + 1), unit.repeat(near * 2)];
    });

  it.each(Object.keys(send) as (keyof typeof send)[])("%s", (platform) => {
    const limit = PLATFORM_CAPTION_LIMITS[platform].charLimit ?? 3000;
    for (const caption of texts(limit)) {
      for (const footer of [null, user]) {
        const full = buildCaptionWithFooter(caption, footer ?? {}, platform);
        const client = send[platform](full);
        const result = buildPlatformPreview({ platform, caption, user: footer });
        expect(result.rendered).toBe(client);
        expect(result.willTruncate).toBe(client !== full);
        expect(result.truncated).toBe(client !== full);
      }
    }
  });
});

// R53: no platform but Pinterest and YouTube gets a count hint, and TikTok's
// preview is as on main 632efda.
describe("buildPlatformPreview on the other platforms, unchanged by Pinterest's unit", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);

  it("tiktok: short and long", () => {
    const footer = "\n\nFor more info visit vibesurfschool.com\n\n#surf #waves";
    expect(buildPlatformPreview({ platform: "tiktok", caption: short, user })).toEqual({
      rendered: `${short}${footer}`,
      charCount: 189,
      limit: 2200,
      truncated: false,
      willTruncate: false,
    });
    const result = buildPlatformPreview({ platform: "tiktok", caption: long, user });
    expect(Object.keys(result).sort()).toEqual(["charCount", "limit", "rendered", "truncated", "willTruncate"]);
    expect(result.rendered.length).toBe(2200);
    expect(result).toMatchObject({ charCount: 3749, limit: 2200, truncated: true, willTruncate: true });
  });

  it("no other platform gets a hint", () => {
    for (const platform of ["x", "tiktok", "instagram", "linkedin", "facebook_page", "google_business_profile"] as const) {
      for (const caption of [short, long, "é \u{1F468}‍\u{1F469}‍\u{1F467} ❤️"]) {
        expect(buildPlatformPreview({ platform, caption, user })).not.toHaveProperty("countHint");
      }
    }
  });
});
