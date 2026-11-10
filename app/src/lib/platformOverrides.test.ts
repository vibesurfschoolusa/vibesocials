import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  adaptMaxLength,
  cleanPlatformOverrides,
  countPlatformOverrides,
  platformCaptionCounter,
  platformOverridesEqual,
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
