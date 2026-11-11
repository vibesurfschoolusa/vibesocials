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
