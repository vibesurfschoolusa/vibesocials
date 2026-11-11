import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";

describe("buildCaptionWithFooter", () => {
  it("returns the trimmed base caption alone when no footer fields are set", () => {
    expect(buildCaptionWithFooter("Just the caption", {})).toBe("Just the caption");
  });

  it("returns base alone when footer fields are explicitly null", () => {
    expect(
      buildCaptionWithFooter("Hello world", {
        companyWebsite: null,
        defaultHashtags: null,
      }),
    ).toBe("Hello world");
  });

  it("appends the website line after a blank line", () => {
    expect(
      buildCaptionWithFooter("Check us out", { companyWebsite: "example.com" }),
    ).toBe("Check us out\n\nFor more info visit example.com");
  });

  it("appends hashtags after a blank line", () => {
    expect(
      buildCaptionWithFooter("New drop", { defaultHashtags: "#new #drop" }),
    ).toBe("New drop\n\n#new #drop");
  });

  it("appends website then hashtags in order, each separated by a blank line", () => {
    expect(
      buildCaptionWithFooter("Big news", {
        companyWebsite: "example.com",
        defaultHashtags: "#news #update",
      }),
    ).toBe("Big news\n\nFor more info visit example.com\n\n#news #update");
  });

  it("trims whitespace from the base caption", () => {
    expect(buildCaptionWithFooter("   padded   ", {})).toBe("padded");
  });

  it("trims each footer field before including it", () => {
    expect(
      buildCaptionWithFooter("Base", {
        companyWebsite: "  example.com  ",
        defaultHashtags: "  #tag  ",
      }),
    ).toBe("Base\n\nFor more info visit example.com\n\n#tag");
  });

  it("omits footer segments whose value is only whitespace", () => {
    expect(
      buildCaptionWithFooter("Base", {
        companyWebsite: "   ",
        defaultHashtags: "\t\n",
      }),
    ).toBe("Base");
  });

  it("collapses an empty base caption to an empty string", () => {
    expect(buildCaptionWithFooter("", {})).toBe("");
  });

  it("collapses a whitespace-only base caption to an empty string", () => {
    expect(buildCaptionWithFooter("   ", {})).toBe("");
  });

  it("still emits the leading blank-line separator when base is empty but footer is present", () => {
    expect(
      buildCaptionWithFooter("", { companyWebsite: "example.com" }),
    ).toBe("\n\nFor more info visit example.com");
  });

  it("never throws when footer fields are undefined", () => {
    expect(() =>
      buildCaptionWithFooter("Safe", {
        companyWebsite: undefined,
        defaultHashtags: undefined,
      }),
    ).not.toThrow();
    expect(
      buildCaptionWithFooter("Safe", {
        companyWebsite: undefined,
        defaultHashtags: undefined,
      }),
    ).toBe("Safe");
  });

  it("handles a mix of null and undefined footer fields without throwing", () => {
    expect(
      buildCaptionWithFooter("Mixed", {
        companyWebsite: null,
        defaultHashtags: undefined,
      }),
    ).toBe("Mixed");
  });
});

// 20: tracking tags on the website link, per platform, opt-in.
describe("buildCaptionWithFooter with a platform", () => {
  const PLATFORMS = [
    "facebook_page",
    "linkedin",
    "x",
    "youtube",
    "pinterest",
    "google_business_profile",
    "instagram",
    "tiktok",
  ] as const;
  const off = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
  const on = { ...off, trackWebsiteLinks: true };
  const today = "Waves\n\nFor more info visit vibesurfschool.com\n\n#surf";

  it.each(PLATFORMS)("with the setting off equals today on %s", (platform) => {
    expect(buildCaptionWithFooter("Waves", off, platform)).toBe(today);
    expect(buildCaptionWithFooter("Waves", { ...off, trackWebsiteLinks: false }, platform)).toBe(today);
    expect(buildCaptionWithFooter("Waves", { ...off, trackWebsiteLinks: null }, platform)).toBe(today);
  });

  it("with no platform passed equals today, even with the setting on", () => {
    expect(buildCaptionWithFooter("Waves", on)).toBe(today);
  });

  it.each([
    ["facebook_page", "facebook"],
    ["linkedin", "linkedin"],
    ["x", "x"],
    ["youtube", "youtube"],
    ["pinterest", "pinterest"],
    ["google_business_profile", "google"],
  ] as const)("with the setting on tags the link on %s", (platform, source) => {
    expect(buildCaptionWithFooter("Waves", on, platform)).toBe(
      `Waves\n\nFor more info visit vibesurfschool.com/?utm_source=${source}&utm_medium=social&utm_campaign=vibesocials\n\n#surf`,
    );
  });

  it.each(["instagram", "tiktok"] as const)("with the setting on leaves %s untagged", (platform) => {
    expect(buildCaptionWithFooter("Waves", on, platform)).toBe(today);
  });

  it("with the setting on and no website adds nothing", () => {
    expect(buildCaptionWithFooter("Waves", { trackWebsiteLinks: true }, "x")).toBe("Waves");
  });
});

// 20, fix round 1: the tags never cost the post its text. On a platform with a
// length limit the tagged link is used only when the whole text fits it.
describe("buildCaptionWithFooter tracking tags only when they fit", () => {
  const on = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf", trackWebsiteLinks: true };
  const plain = (caption: string) => `${caption}\n\nFor more info visit vibesurfschool.com\n\n#surf`;
  const tagged = (caption: string, source: string) =>
    `${caption}\n\nFor more info visit vibesurfschool.com/?utm_source=${source}&utm_medium=social&utm_campaign=vibesocials\n\n#surf`;

  it.each([
    ["x", "x", 280],
    ["pinterest", "pinterest", 800],
    ["google_business_profile", "google", 1500],
  ] as const)("on %s: tagged up to the limit, plain one character over", (platform, source, limit) => {
    const room = limit - tagged("", source).length;
    expect(buildCaptionWithFooter("a".repeat(room - 1), on, platform)).toBe(tagged("a".repeat(room - 1), source));
    expect(buildCaptionWithFooter("a".repeat(room), on, platform)).toBe(tagged("a".repeat(room), source));
    expect(buildCaptionWithFooter("a".repeat(room + 1), on, platform)).toBe(plain("a".repeat(room + 1)));
  });

  it("on X counts the text without @-mentions, as the X client does", () => {
    const room = 280 - tagged("", "x").length;
    const caption = `@ana_surf ${"a".repeat(room)}`;
    expect(buildCaptionWithFooter(caption, on, "x")).toBe(tagged(caption, "x"));
    expect(buildCaptionWithFooter(`${caption}a`, on, "x")).toBe(plain(`${caption}a`));
  });

  it("counts code points, so an emoji caption never gets the tags into a cut", () => {
    // The surfer emoji below is one grapheme but four code points; Pinterest
    // cuts on code points too (fitPinterestDescription).
    const surfer = "\u{1F3C4}\u200D\u2642\uFE0F";
    const room = 800 - tagged("", "pinterest").length;
    const caption = surfer.repeat(room);
    expect(buildCaptionWithFooter(caption, on, "pinterest")).toBe(plain(caption));
  });

  it("always tags on a platform without a limit", () => {
    const caption = "a".repeat(20_000);
    expect(buildCaptionWithFooter(caption, on, "linkedin")).toBe(tagged(caption, "linkedin"));
  });
});
