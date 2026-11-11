import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

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
  it("counts against the platform limit minus the footer the app appends", () => {
    // footer = "\n\nFor more info visit a.co" = 2 + 20 + 4 = 26 characters
    const footer = { companyWebsite: "a.co", defaultHashtags: null };
    const counter = platformCaptionCounter("hello", "x", footer);
    expect(counter).toEqual({ length: 5, max: 254, over: false, label: "5 / 254" });
  });

  it("is over when the text is longer than the room left", () => {
    const counter = platformCaptionCounter("y".repeat(281), "x", {});
    expect(counter.over).toBe(true);
    expect(counter.label).toBe("281 / 280");
  });

  it("falls back to the 10,000-character cap for a platform with no limit", () => {
    expect(platformCaptionCounter("hi", "linkedin", {})).toEqual({
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
    expect(adaptMaxLength("linkedin", {})).toBeUndefined();
  });

  it("never goes below the 50 the route accepts", () => {
    expect(adaptMaxLength("x", { defaultHashtags: "#".repeat(260) })).toBe(50);
  });
});

describe("applyAdaptedCaption", () => {
  it("fills the platform's caption while it is switched on", () => {
    expect(applyAdaptedCaption({ x: "old", linkedin: "keep" }, "x", "new")).toEqual({
      x: "new",
      linkedin: "keep",
    });
  });

  it("drops the answer when that platform's caption was switched off meanwhile", () => {
    const prev = { linkedin: "keep" };
    expect(applyAdaptedCaption(prev, "x", "new")).toBe(prev);
    expect(applyAdaptedCaption(null, "x", "new")).toEqual({});
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

// 20: the room for a caption is counted with the plain footer whatever the
// tracking-tags setting: the tags are only used when they fit (captionFooter.ts),
// so switching the setting on never changes a counter.
describe("platformCaptionCounter and adaptMaxLength with tracking tags", () => {
  const off = { companyWebsite: "a.co", defaultHashtags: "#surf" };
  const on = { ...off, trackWebsiteLinks: true };

  it("gives every platform the same room with the setting on as off", () => {
    for (const platform of ["x", "pinterest", "google_business_profile", "instagram", "tiktok", "linkedin"] as const) {
      expect(platformCaptionCounter("hello", platform, on)).toEqual(platformCaptionCounter("hello", platform, off));
      expect(adaptMaxLength(platform, on)).toBe(adaptMaxLength(platform, off));
    }
    // "\n\nFor more info visit a.co\n\n#surf" is 33 characters.
    expect(platformCaptionCounter("hello", "x", on).max).toBe(280 - 33);
  });
});
