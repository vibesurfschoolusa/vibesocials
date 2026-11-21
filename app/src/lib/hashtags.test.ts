import { describe, expect, it } from "vitest";

import { hashtagsIn } from "./hashtags";

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
});
