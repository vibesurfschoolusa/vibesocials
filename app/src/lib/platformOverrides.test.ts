import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { findOverlongCaption } from "./captionLimits";
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

  // R48 review: a Story publishes no caption, so a Story-only platform's own one is never sent.
  it("drops entries for platforms sent as a Story only", () => {
    expect(cleanPlatformOverrides({ instagram: "For IG", x: "For X" }, "Main", SELECTED, ["instagram"])).toEqual({
      x: "For X",
    });
    expect(cleanPlatformOverrides({ instagram: "For IG" }, "Main", SELECTED, ["instagram"])).toBeNull();
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

// R51 publishing-flow L2: with no limit of its own a platform's caption meets
// only the routes' 10,000 cap, so the counter counts as they do (UTF-16 units).
describe("platformCaptionCounter without a platform limit", () => {
  it.each(["facebook_page"] as const)("%s: 9,200 letters and 500 emoji read over", (platform) => {
    const counter = platformCaptionCounter(`${"a".repeat(9200)}${"🌊".repeat(500)}`, platform, null);
    expect(counter.length).toBe(10_200);
    expect(counter.over).toBe(true);
    expect(counter.label).toBe("10,200 / 10,000");
  });

  it.each(["facebook_page"] as const)("%s: the counter and the server agree at 10,000 and 10,001 units", (platform) => {
    for (const text of [`${"a".repeat(9998)}🌊`, `${"a".repeat(9999)}🌊`, "a".repeat(10_000), "a".repeat(10_001)]) {
      const serverRefuses = findOverlongCaption({ perPlatformOverrides: { [platform]: text } }) !== null;
      expect(platformCaptionCounter(text, platform, null).over).toBe(serverRefuses);
    }
    expect(platformCaptionCounter("a".repeat(10_000), platform, null).over).toBe(false);
    expect(platformCaptionCounter("a".repeat(10_001), platform, null).over).toBe(true);
  });
});

// R52 platform-clients L1: YouTube's description is counted against its 5,000
// UTF-8 bytes, red exactly when the preview says it will be shortened.
describe("platformCaptionCounter and adaptMaxLength on YouTube", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf", trackWebsiteLinks: true };

  it.each([
    [4812, false, "4,812 / 5,000"],
    [5000, false, "5,000 / 5,000"],
    [5001, true, "5,001 / 5,000"],
  ] as const)("ASCII %i long reads against 5,000", (length, over, label) => {
    const text = "a".repeat(length);
    expect(platformCaptionCounter(text, "youtube", null)).toEqual({ length, max: 5000, over, label });
    expect(buildPlatformPreview({ platform: "youtube", caption: text }).willTruncate).toBe(over);
  });

  it("reads a short description full of emoji as over, and says why the number jumps", () => {
    const text = `${"Waves \u{1F30A}".repeat(500)}!`; // 4,001 UTF-16 units, 5,001 counted
    const counter = platformCaptionCounter(text, "youtube", null);
    expect(counter.length).toBe(5001);
    expect(counter.over).toBe(true);
    expect(counter.label).toBe("5,001 / 5,000");
    expect(counter.hint).toBe("YouTube counts accented letters, curly quotes and emoji as 2 or more.");
  });

  it("names the < and > swap when the text has one", () => {
    expect(platformCaptionCounter("I <3 waves", "youtube", null)).toEqual({
      length: 12,
      max: 5000,
      over: false,
      label: "12 / 5,000",
      hint: "YouTube counts < and > as 3.",
    });
  });

  it("says incl. footer as before, and the footer can push it over", () => {
    const short = platformCaptionCounter("hello", "youtube", footer);
    const full = buildCaptionWithFooter("hello", footer, "youtube");
    expect(short.label).toBe(`${full.length} / 5,000 incl. footer`);
    expect(short.over).toBe(false);
    const pushed = platformCaptionCounter("a".repeat(4950), "youtube", footer);
    expect(pushed.over).toBe(true);
    expect(pushed.label.endsWith(" incl. footer")).toBe(true);
    expect(platformCaptionCounter("a".repeat(4950), "youtube", null).over).toBe(false);
  });

  it("is over exactly when the preview says the post will be shortened", () => {
    for (const text of ["hi", "é".repeat(2500), "é".repeat(2501), `${"a".repeat(4900)}\u{1F30A}`, "<".repeat(1667), "<".repeat(1666)]) {
      for (const user of [null, footer]) {
        expect(platformCaptionCounter(text, "youtube", user).over).toBe(
          buildPlatformPreview({ platform: "youtube", caption: text, user }).willTruncate,
        );
      }
    }
  });

  it("is over whenever the server's 10,000 cap refuses it", () => {
    for (const text of ["a".repeat(10_001), "\u{1F30A}".repeat(5001)]) {
      expect(findOverlongCaption({ perPlatformOverrides: { youtube: text } })).not.toBeNull();
      expect(platformCaptionCounter(text, "youtube", null).over).toBe(true);
    }
  });

  it("gives Adapt for YouTube the room left after the footer, as YouTube counts it", () => {
    expect(adaptMaxLength("youtube", null)).toBe(5000);
    const footerText = buildCaptionWithFooter("", footer, "youtube");
    expect(adaptMaxLength("youtube", footer)).toBe(5000 - footerText.length);
    expect(adaptMaxLength("youtube", { defaultHashtags: "#café" })).toBe(5000 - "\n\n#café".length - 1);
  });
});

// R52: every other platform's counter and Adapt room are as they were. Values
// pinned from main f796e2e.
describe("platformCaptionCounter and adaptMaxLength on other platforms, unchanged", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);

  it.each([
    ["x", "198 / 280 incl. footer", 280, "3,749 / 280", true, 221],
    ["instagram", "189 / 2,200 incl. footer", 2200, "3,749 / 2,200", true, 2146],
    ["linkedin", "253 / 3,000 incl. footer", 3000, "3,749 / 3,000", true, 2946],
    ["facebook_page", "139 / 10,000", 10_000, "3,750 / 10,000", false, undefined],
    ["google_business_profile", "251 / 1,500 incl. footer", 1500, "3,749 / 1,500", true, 1446],
  ] as const)("%s", (platform, shortLabel, max, longLabel, longOver, adapt) => {
    expect(platformCaptionCounter(short, platform, user)).toEqual({
      length: Number(shortLabel.split(" ")[0].replace(",", "")),
      max,
      over: false,
      label: shortLabel,
    });
    expect(platformCaptionCounter(long, platform, user)).toEqual({
      length: Number(longLabel.split(" ")[0].replace(",", "")),
      max,
      over: longOver,
      label: longLabel,
    });
    expect(adaptMaxLength(platform, user)).toBe(adapt);
  });
});

// R52 fix review L2: YouTube always posts and counts its footer, so the label
// says "incl. footer" whenever there is one, over the limit too.
describe("platformCaptionCounter on YouTube: incl. footer", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };

  it("under the limit with a footer", () => {
    const counter = platformCaptionCounter("hello", "youtube", footer);
    expect(counter.over).toBe(false);
    expect(counter.label).toBe(`${buildCaptionWithFooter("hello", footer, "youtube").length} / 5,000 incl. footer`);
  });

  it("over the limit with a footer: still incl. footer", () => {
    const counter = platformCaptionCounter("a".repeat(5500), "youtube", footer);
    expect(counter.over).toBe(true);
    const length = buildCaptionWithFooter("a".repeat(5500), footer, "youtube").length;
    expect(counter.label).toBe(`${length.toLocaleString("en-US")} / 5,000 incl. footer`);
  });

  it("no footer: no incl. footer, under or over", () => {
    for (const user of [null, {}, { companyWebsite: "  ", defaultHashtags: "" }]) {
      expect(platformCaptionCounter("hello", "youtube", user).label).toBe("5 / 5,000");
      expect(platformCaptionCounter("a".repeat(5500), "youtube", user).label).toBe("5,500 / 5,000");
    }
  });
});

// R53 platform-clients L1: Pinterest is counted in code points, as
// fitPinterestDescription cuts, and is red exactly when the Pin is cut.
describe("platformCaptionCounter and adaptMaxLength on Pinterest", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf", trackWebsiteLinks: true };
  const HINT = "Pinterest counts some characters, such as emoji, as 2 or more.";
  const heart = "❤️";

  it("reads the finding's 760 characters with 50 hearts as 810 / 800, too long, with the hint", () => {
    const counter = platformCaptionCounter(`${"a".repeat(710)}${heart.repeat(50)}`, "pinterest", null);
    expect(counter).toEqual({ length: 810, max: 800, over: true, label: "810 / 800", hint: HINT });
  });

  it.each([
    [799, false, "799 / 800"],
    [800, false, "800 / 800"],
    [801, true, "801 / 800"],
  ] as const)("ASCII %i long: no hint, as before", (length, over, label) => {
    expect(platformCaptionCounter("a".repeat(length), "pinterest", null)).toEqual({ length, max: 800, over, label });
  });

  it("is over exactly when the preview says the Pin will be cut", () => {
    for (const text of [
      heart.repeat(400),
      `${heart.repeat(400)}a`,
      "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(114),
      `${"\u{1F1FA}\u{1F1F8}".repeat(399)}ab`,
      "é".repeat(401),
      "hello",
    ]) {
      for (const user of [null, footer]) {
        expect(platformCaptionCounter(text, "pinterest", user).over).toBe(
          buildPlatformPreview({ platform: "pinterest", caption: text, user }).willTruncate,
        );
      }
    }
  });

  it("says incl. footer as before when the footer is posted", () => {
    const counter = platformCaptionCounter(`Love ${heart}`, "pinterest", footer);
    const full = buildCaptionWithFooter(`Love ${heart}`, footer, "pinterest");
    expect(counter).toEqual({
      length: [...full].length,
      max: 800,
      over: false,
      label: `${[...full].length} / 800 incl. footer`,
      hint: HINT,
    });
  });

  it("gives Adapt the room left after the footer, counted in code points", () => {
    expect(adaptMaxLength("pinterest", null)).toBe(800);
    expect(adaptMaxLength("pinterest", { defaultHashtags: "#surf" })).toBe(800 - "\n\n#surf".length);
    expect(adaptMaxLength("pinterest", { defaultHashtags: `#love ${heart}` })).toBe(800 - [...`\n\n#love ${heart}`].length);
  });
});

// R53: TikTok's counter and Adapt room, pinned from main 632efda, with no hint.
describe("platformCaptionCounter on TikTok, unchanged by Pinterest's unit", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);

  it("short, long, a family and an accent", () => {
    expect(platformCaptionCounter(short, "tiktok", user)).toEqual({
      length: 189,
      max: 2200,
      over: false,
      label: "189 / 2,200 incl. footer",
    });
    expect(platformCaptionCounter(long, "tiktok", user)).toEqual({ length: 3749, max: 2200, over: true, label: "3,749 / 2,200" });
    expect(platformCaptionCounter("é \u{1F468}‍\u{1F469}‍\u{1F467}", "tiktok", null)).toEqual({
      length: 3,
      max: 2200,
      over: false,
      label: "3 / 2,200",
    });
    expect(adaptMaxLength("tiktok", user)).toBe(2146);
  });
});
