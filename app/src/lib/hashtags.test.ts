import { describe, expect, it } from "vitest";

import { hashtagsIn } from "./hashtags";
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
});

describe("Instagram's hashtag limit with combining marks", () => {
  it("drops a 31st Devanagari tag whole, leaving no stray marks", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ");
    const { caption, droppedHashtags } = fitInstagramTags(`Waves ${thirty} #भारत`);
    expect(caption).toBe(`Waves ${thirty}`);
    expect(droppedHashtags).toEqual(["#भारत"]);
  });
});
