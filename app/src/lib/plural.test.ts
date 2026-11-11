import { describe, expect, it } from "vitest";

import { countWord } from "./plural";

// Go-live check 2026-11-11: "1 comments", "1 views", "1 likes" on Activity and
// the dashboard. 1 takes the singular; every other number, 0 included, the plural.
describe("countWord", () => {
  const words: Array<[string, string]> = [
    ["view", "views"],
    ["like", "likes"],
    ["comment", "comments"],
    ["share", "shares"],
    ["click", "clicks"],
    ["save", "saves"],
    ["post", "posts"],
    ["day", "days"],
    ["video", "videos"],
  ];

  for (const [one, many] of words) {
    it(`${many}: 0, 1, 2 and 1000`, () => {
      expect(countWord(0, one, many)).toBe(many);
      expect(countWord(1, one, many)).toBe(one);
      expect(countWord(2, one, many)).toBe(many);
      expect(countWord(1000, one, many)).toBe(many);
    });
  }

  it("a missing number reads as plural (\"— comments\")", () => {
    expect(countWord(null, "comment", "comments")).toBe("comments");
  });
});
