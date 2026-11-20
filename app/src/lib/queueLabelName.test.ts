import { describe, expect, it } from "vitest";

import { labelName } from "./queueLabelName";

// R5-pages L12: a button's name carries the caption's start, not all of it.
describe("labelName, the caption in a Queue button's name", () => {
  it("keeps a short caption whole", () => {
    expect(labelName("Dawn patrol")).toBe("Dawn patrol");
  });

  it("cuts a long caption to about 40 characters with an ellipsis", () => {
    const caption = "Sunday session at the pier with the whole crew, bring your board and sunscreen";
    const name = labelName(caption);
    expect(name).toBe("Sunday session at the pier with the who…");
    expect(Array.from(name)).toHaveLength(40);
  });

  it("joins lines and spaces into one line, and never cuts an emoji", () => {
    expect(labelName("Waves\n\n  today")).toBe("Waves today");
    const name = labelName(`${"a".repeat(38)}🏄‍♀️ more words after`);
    expect(name).toBe(`${"a".repeat(38)}🏄‍♀️…`);
  });

  it("names a post without a caption", () => {
    expect(labelName(null)).toBe("Untitled post");
    expect(labelName("   ")).toBe("Untitled post");
  });
});
