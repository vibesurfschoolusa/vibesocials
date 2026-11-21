import { describe, expect, it } from "vitest";

import { hashtagsIn, withoutHashtagSigns } from "./hashtags";
import { fitInstagramTags } from "@/server/platforms/instagramClient";

// R58 platform-clients L1: one hashtag rule for Instagram and YouTube.
describe("hashtagsIn", () => {
  const tags = (text: string) => hashtagsIn(text).map((match) => match[0]);

  it("reads accented tags whole", () => {
    expect(tags("Clases para niños #niños #café #ÉcoleSurf #surf")).toEqual(["#niños", "#café", "#ÉcoleSurf", "#surf"]);
  });

  it("a tag follows a character that cannot be part of a word", () => {
    expect(tags("C# issue#4 &#39; ##double page#frag (#ok)")).toEqual(["#ok"]);
  });

  it("gives each match's index, for callers that cut the text", () => {
    expect(hashtagsIn("a #b").map((match) => match.index)).toEqual([2]);
  });

  // R59 platform-clients L1: a combining mark (a Hindi or Thai vowel sign, or
  // an accent typed as its own character) is part of the tag.
  it("reads a Devanagari tag whole", () => {
    expect(tags("नमस्ते #हिन्दी #surf")).toEqual(["#हिन्दी", "#surf"]);
  });

  it("reads a Thai tag whole", () => {
    expect(tags("สวัสดี #ไม่ #สวัสดี")).toEqual(["#ไม่", "#สวัสดี"]);
  });

  it("reads a decomposed accent whole", () => {
    expect(tags("Coffee #café time")).toEqual(["#café"]);
  });

  it("a tag never starts right after a combining mark", () => {
    expect(tags("हि#न्दी")).toEqual([]);
  });

  // R60 platform-clients L1: as twitter-text, a variation selector (U+FE0E,
  // U+FE0F, which ends "☀️" and "❤️") may come right before the "#".
  it.each([
    ["☀\uFE0F#summer", ["#summer"]],
    ["🏄\u200D♂\uFE0F#surf", ["#surf"]],
    ["❤\uFE0F#love #surf", ["#love", "#surf"]],
    ["☀\uFE0E#summer", ["#summer"]],
  ])("a tag right after an emoji is a tag: %s", (text, expected) => {
    expect(tags(text)).toEqual(expected);
  });

  it("the keycap \"#\uFE0F\u20E3\" is not a tag, nor a \"#\" before U+20E3", () => {
    expect(tags("Press #\uFE0F\u20E3 now")).toEqual([]);
    expect(tags("#\u20E3")).toEqual([]);
    expect(tags("#\uFE0F\u20E3 #surf")).toEqual(["#surf"]);
  });
});

describe("Instagram's hashtag limit with combining marks", () => {
  it("drops a 31st Devanagari tag whole, leaving no stray marks", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ");
    const { caption, droppedHashtags } = fitInstagramTags(`Waves ${thirty} #भारत`);
    expect(caption).toBe(`Waves ${thirty}`);
    expect(droppedHashtags).toEqual(["#भारत"]);
  });

  // R60 platform-clients L1: a tag right after an emoji counts towards the 30.
  it("counts emoji-led tags, so a 31st is dropped", () => {
    const thirty = Array.from({ length: 29 }, (_, i) => `#t${i}`).join(" ");
    const { caption, droppedHashtags } = fitInstagramTags(`Waves ☀\uFE0F#summer ${thirty} ❤\uFE0F#love`);
    expect(droppedHashtags).toEqual(["#love"]);
    expect(caption).toBe(`Waves ☀\uFE0F#summer ${thirty} ❤\uFE0F`);
  });
});

// R60 new-customer L2: the AI answers lose a tag's "#" only when its word has a
// letter or a mark (brandVoice's TAG_WORD), so "#1" stays.
describe("withoutHashtagSigns", () => {
  it.each([
    ["Voted #1 surf school #surf", "Voted #1 surf school surf"],
    ["#2024 was a year of #niños and ##waves", "#2024 was a year of niños and waves"],
    ["A lone # goes", "A lone  goes"],
    ["No signs here", "No signs here"],
  ])("%s", (text, expected) => {
    expect(withoutHashtagSigns(text)).toBe(expected);
  });
});
