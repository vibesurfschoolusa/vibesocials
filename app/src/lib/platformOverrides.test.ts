import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";
import { buildPlatformPreview } from "./platformPreview";

import {
  adaptMaxLength,
  applyAdaptedCaption,
  cleanPlatformOverrides,
  countPlatformOverrides,
  platformCaptionCounter,
  platformOverridesEqual,
  queueOverridesToSend,
  setPlatformOverride,
} from "./platformOverrides";

const SELECTED: Platform[] = ["x", "linkedin", "instagram"];

describe("cleanPlatformOverrides", () => {
  it("keeps a real override unchanged", () => {
    expect(cleanPlatformOverrides({ x: "  Short for X  " }, "Main caption", SELECTED)).toEqual({
      x: "  Short for X  ",
    });
  });

  it("drops empty and whitespace-only entries", () => {
    expect(
      cleanPlatformOverrides({ x: "", linkedin: "   \n ", instagram: "Real" }, "Main", SELECTED),
    ).toEqual({ instagram: "Real" });
  });

  it("drops an entry equal to the main caption (ignoring surrounding whitespace)", () => {
    expect(
      cleanPlatformOverrides({ x: "Main caption", linkedin: " Main caption \n" }, "Main caption", SELECTED),
    ).toBeNull();
  });

  it("drops entries for platforms that are not selected", () => {
    expect(
      cleanPlatformOverrides({ tiktok: "For TikTok", x: "For X" }, "Main", SELECTED),
    ).toEqual({ x: "For X" });
  });

  it("drops keys that are not a platform", () => {
    expect(
      cleanPlatformOverrides(
        { x: "For X", foo: "bar" } as unknown as Partial<Record<Platform, string>>,
        "Main",
        SELECTED,
      ),
    ).toEqual({ x: "For X" });
  });

  it("returns null when nothing is left, or nothing was given", () => {
    expect(cleanPlatformOverrides({ tiktok: "x", x: "" }, "Main", SELECTED)).toBeNull();
    expect(cleanPlatformOverrides({}, "Main", SELECTED)).toBeNull();
    expect(cleanPlatformOverrides(null, "Main", SELECTED)).toBeNull();
    expect(cleanPlatformOverrides(undefined, "Main", SELECTED)).toBeNull();
  });
});

describe("setPlatformOverride", () => {
  it("switching on starts as a copy of the main caption", () => {
    expect(setPlatformOverride({}, "x", true, "Main caption")).toEqual({ x: "Main caption" });
    expect(setPlatformOverride(null, "x", true, "Main caption")).toEqual({ x: "Main caption" });
  });

  it("switching on keeps text that is already there", () => {
    expect(setPlatformOverride({ x: "Mine" }, "x", true, "Main")).toEqual({ x: "Mine" });
  });

  it("switching off removes that platform's caption and leaves the others", () => {
    const before = { x: "For X", linkedin: "For LinkedIn" };
    expect(setPlatformOverride(before, "x", false, "Main")).toEqual({ linkedin: "For LinkedIn" });
    // The input is not mutated (React state).
    expect(before).toEqual({ x: "For X", linkedin: "For LinkedIn" });
  });
});

describe("countPlatformOverrides", () => {
  it("counts the listed platforms that have their own caption switched on", () => {
    expect(countPlatformOverrides({ x: "a", tiktok: "b", linkedin: "" }, SELECTED)).toBe(2);
    expect(countPlatformOverrides(null, SELECTED)).toBe(0);
  });
});

describe("platformOverridesEqual", () => {
  it("compares by content, treating null and {} alike", () => {
    expect(platformOverridesEqual(null, {})).toBe(true);
    expect(platformOverridesEqual({ x: "a" }, { x: "a" })).toBe(true);
    expect(platformOverridesEqual({ x: "a" }, { x: "b" })).toBe(false);
    expect(platformOverridesEqual({ x: "a" }, { x: "a", linkedin: "c" })).toBe(false);
    expect(platformOverridesEqual({ x: "a" }, null)).toBe(false);
  });
});

describe("platformCaptionCounter", () => {
  // Review fix: the counter counts what will be posted (the preview's text),
  // so it reserves no room for footer parts that publishing drops.
  it("counts the text that will be posted, footer included, against the limit", () => {
    // "hello" + "\n\nFor more info visit a.co" = 5 + 2 + 20 + a link X weighs 23 = 50
    const footer = { companyWebsite: "a.co", defaultHashtags: null };
    const counter = platformCaptionCounter("hello", "x", footer);
    expect(counter).toEqual({ length: 50, max: 280, over: false, label: "50 / 280 incl. footer" });
  });

  it("is not red for 201 characters + a long tracked website + five hashtags: the hashtags go", () => {
    const footer = {
      companyWebsite: "vibesurfschool.com/lessons/fort-lauderdale/private-surf-lessons",
      defaultHashtags: "#surf #surflessons #fortlauderdale #miami #beach",
      trackWebsiteLinks: true,
    };
    const caption = "a".repeat(201);
    const counter = platformCaptionCounter(caption, "x", footer);
    const preview = buildPlatformPreview({ platform: "x", caption, user: footer });
    expect(counter.over).toBe(false);
    expect(counter.length).toBe(preview.charCount);
    expect(preview.rendered).toBe(buildCaptionWithFooter(caption, footer, "x"));
    expect(preview.rendered).not.toContain("#surf");
  });

  it("is red when the caption alone is over, and the preview says it will be shortened", () => {
    const footer = { companyWebsite: "a.co", defaultHashtags: "#surf" };
    const caption = "a".repeat(281);
    expect(platformCaptionCounter(caption, "x", footer).over).toBe(true);
    expect(buildPlatformPreview({ platform: "x", caption, user: footer }).willTruncate).toBe(true);
  });

  it("leaves @-mentions out of the X count", () => {
    const counter = platformCaptionCounter(`@ana_surf ${"a".repeat(280)}`, "x", {});
    expect(counter).toEqual({ length: 280, max: 280, over: false, label: "280 / 280" });
  });

  it("counts LinkedIn against 3,000 with the footer dropped first", () => {
    const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
    const counter = platformCaptionCounter("a".repeat(2990), "linkedin", footer);
    expect(counter).toEqual({ length: 2990, max: 3000, over: false, label: "2,990 / 3,000" });
    expect(platformCaptionCounter("a".repeat(3001), "linkedin", footer).over).toBe(true);
  });

  // R5-publishing L2: every platform with a limit drops the footer whole, so the
  // counter is not red for a caption that fits once the footer goes.
  it.each([
    ["instagram", 2200, "2,190 / 2,200"],
    ["google_business_profile", 1500, "1,490 / 1,500"],
    ["pinterest", 800, "790 / 800"],
  ] as const)("counts %s against its limit with the footer dropped first", (platform, limit, label) => {
    const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
    const counter = platformCaptionCounter("a".repeat(limit - 10), platform, footer);
    expect(counter).toEqual({ length: limit - 10, max: limit, over: false, label });
    expect(platformCaptionCounter("a".repeat(limit + 1), platform, footer).over).toBe(true);
  });

  it("is over when the text is longer than the room left", () => {
    const counter = platformCaptionCounter("y".repeat(281), "x", {});
    expect(counter.over).toBe(true);
    expect(counter.label).toBe("281 / 280");
  });

  it("says the footer is included only when some of it is posted", () => {
    const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
    expect(platformCaptionCounter("hello", "linkedin", footer).label).toBe("52 / 3,000 incl. footer");
    // 2,990 characters leave no room: the footer is dropped, so no hint.
    expect(platformCaptionCounter("a".repeat(2990), "linkedin", footer).label).toBe("2,990 / 3,000");
    expect(platformCaptionCounter("hello", "linkedin", {}).label).toBe("5 / 3,000");
  });

  // Fix round 1 (M5, M6): X is counted by its own weight; LinkedIn has 3,000.
  it("counts X by weight: an emoji 2, a link 23", () => {
    expect(platformCaptionCounter("\u{1F30A}\u{1F30A}", "x", {}).length).toBe(4);
    expect(platformCaptionCounter("https://vibesurfschool.com/lessons/fort-lauderdale", "x", {}).length).toBe(23);
  });

  it("counts LinkedIn against 3,000", () => {
    expect(platformCaptionCounter("hi", "linkedin", {}).label).toBe("2 / 3,000");
  });

  it("falls back to the 10,000-character cap for a platform with no limit", () => {
    expect(platformCaptionCounter("hi", "facebook_page", {})).toEqual({
      length: 2,
      max: 10_000,
      over: false,
      label: "2 / 10,000",
    });
  });
});

describe("adaptMaxLength", () => {
  it("is the platform limit minus the footer length", () => {
    expect(adaptMaxLength("x", {})).toBe(280);
    expect(adaptMaxLength("x", { defaultHashtags: "#a #b" })).toBe(280 - 7);
    expect(adaptMaxLength("pinterest", undefined)).toBe(800);
  });

  it("is undefined for a platform with no limit", () => {
    expect(adaptMaxLength("facebook_page", {})).toBeUndefined();
  });

  it("never goes below the 50 the route accepts", () => {
    expect(adaptMaxLength("x", { defaultHashtags: "#".repeat(260) })).toBe(50);
  });
});

describe("applyAdaptedCaption", () => {
  it("fills the platform's caption while it reads as at the press", () => {
    expect(applyAdaptedCaption({ x: "old", linkedin: "keep" }, "x", "new", "old")).toEqual({
      x: "new",
      linkedin: "keep",
    });
  });

  it("drops the answer when that platform's caption was switched off meanwhile", () => {
    const prev = { linkedin: "keep" };
    expect(applyAdaptedCaption(prev, "x", "new", "old")).toBe(prev);
    expect(applyAdaptedCaption(null, "x", "new", "old")).toEqual({});
  });

  it("R38: drops the answer when that platform's caption was edited meanwhile", () => {
    const prev = { x: "old, edited" };
    expect(applyAdaptedCaption(prev, "x", "new", "old")).toBe(prev);
  });
});

describe("queueOverridesToSend", () => {
  const PLATFORMS: Platform[] = ["x", "linkedin", "instagram"];
  const base = { mainCaption: "Main caption", platforms: PLATFORMS, hasOwnCaption: true };

  it("sends nothing when the captions are untouched", () => {
    const saved = { x: "For X", linkedin: "For LinkedIn" };
    expect(queueOverridesToSend({ ...base, current: { ...saved }, saved })).toBeUndefined();
    expect(queueOverridesToSend({ ...base, current: null, saved: null })).toBeUndefined();
    expect(queueOverridesToSend({ ...base, current: {}, saved: null })).toBeUndefined();
  });

  it("sends null when the last caption is removed", () => {
    expect(queueOverridesToSend({ ...base, current: {}, saved: { x: "For X" } })).toBeNull();
  });

  it("sends the other caption when one of two is removed", () => {
    expect(
      queueOverridesToSend({
        ...base,
        current: { linkedin: "For LinkedIn" },
        saved: { x: "For X", linkedin: "For LinkedIn" },
      }),
    ).toEqual({ linkedin: "For LinkedIn" });
  });

  it("sends a changed caption", () => {
    expect(
      queueOverridesToSend({ ...base, current: { x: "Newer" }, saved: { x: "For X" } }),
    ).toEqual({ x: "Newer" });
  });

  it("removing a caption equal to the new main caption still clears the stored one", () => {
    // Saved X caption "Main caption"; the user removes it. Cleaning both sides
    // against the main caption would hide the change and leave it stored.
    expect(
      queueOverridesToSend({ ...base, current: {}, saved: { x: "Main caption" } }),
    ).toBeNull();
  });

  it("an older post with no caption of its own always sends what the dialog shows", () => {
    const shown = { x: "From the media item" };
    expect(
      queueOverridesToSend({ ...base, hasOwnCaption: false, current: { ...shown }, saved: shown }),
    ).toEqual({ x: "From the media item" });
    expect(
      queueOverridesToSend({ ...base, hasOwnCaption: false, current: null, saved: null }),
    ).toBeNull();
  });
});

// 20: "Adapt" asks for room counted with the plain footer whatever the
// tracking-tags setting: the tags are only used when they fit (captionFooter.ts).
// The counter counts the text that will be posted, tags included when used.
describe("platformCaptionCounter and adaptMaxLength with tracking tags", () => {
  const off = { companyWebsite: "a.co", defaultHashtags: "#surf" };
  const on = { ...off, trackWebsiteLinks: true };

  it("gives every platform the same Adapt room with the setting on as off", () => {
    for (const platform of ["x", "pinterest", "google_business_profile", "instagram", "tiktok", "linkedin"] as const) {
      expect(adaptMaxLength(platform, on)).toBe(adaptMaxLength(platform, off));
    }
  });

  it("counts the posted text with the tagged link where it is used", () => {
    for (const platform of ["x", "pinterest", "google_business_profile", "linkedin"] as const) {
      expect(platformCaptionCounter("hello", platform, on).length).toBe(
        buildPlatformPreview({ platform, caption: "hello", user: on }).charCount,
      );
    }
    // On X the tagged link weighs 23 like the plain one.
    expect(platformCaptionCounter("hello", "x", on)).toEqual(platformCaptionCounter("hello", "x", off));
  });
});
