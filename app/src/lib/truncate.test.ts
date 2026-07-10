import { describe, expect, it } from "vitest";

import { truncateGraphemes } from "./truncate";

// Grapheme count via the same primitive the implementation uses, so assertions
// about "<= max graphemes" are measured the way the helper measures.
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const countGraphemes = (s: string): number => [...seg.segment(s)].length;

// True if `s` contains a lone (unpaired) UTF-16 surrogate — the tell-tale sign
// that a multi-code-unit grapheme was sliced through its middle.
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: the next unit must be a low surrogate.
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // valid pair — skip its low half
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no preceding high surrogate
    }
  }
  return false;
}

describe("truncateGraphemes", () => {
  it("returns ASCII text under the limit unchanged", () => {
    expect(truncateGraphemes("hello", 10)).toBe("hello");
  });

  it("returns ASCII text exactly at the limit unchanged (boundary)", () => {
    expect(truncateGraphemes("hello", 5)).toBe("hello");
  });

  it("cuts ASCII text over the limit to exactly maxGraphemes (no ellipsis)", () => {
    expect(truncateGraphemes("abcdef", 5)).toBe("abcde");
  });

  it("returns an empty string unchanged for any positive limit", () => {
    expect(truncateGraphemes("", 5)).toBe("");
  });

  it("returns '' when maxGraphemes is 0", () => {
    expect(truncateGraphemes("anything", 0)).toBe("");
  });

  it("keeps an emoji whole at the cut boundary (no lone surrogate)", () => {
    // "a😀b": graphemes ["a","😀","b"]; a naive substring(0,2) by code unit would
    // land inside the emoji's surrogate pair. Grapheme-cutting keeps it intact.
    const result = truncateGraphemes("a😀b", 2);
    expect(result).toBe("a😀");
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(countGraphemes(result)).toBe(2);
  });

  it("never produces a lone surrogate at any cut point", () => {
    const text = "a😀b👨‍👩‍👧c🇺🇸d🇬🇧e"; // ascii + emoji + ZWJ family + flags
    const total = countGraphemes(text);
    for (let n = 0; n <= total + 2; n++) {
      expect(hasLoneSurrogate(truncateGraphemes(text, n))).toBe(false);
    }
  });

  it("counts a ZWJ family emoji as a single grapheme (fits, unchanged)", () => {
    expect(countGraphemes("👨‍👩‍👧")).toBe(1);
    expect(truncateGraphemes("👨‍👩‍👧", 1)).toBe("👨‍👩‍👧");
  });

  it("keeps a ZWJ family emoji atomic when truncating away a following char", () => {
    const result = truncateGraphemes("👨‍👩‍👧X", 1);
    expect(result).toBe("👨‍👩‍👧");
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(countGraphemes(result)).toBe(1);
  });

  it("treats a regional-indicator flag as a single grapheme", () => {
    expect(countGraphemes("🇺🇸")).toBe(1);
    const result = truncateGraphemes("🇺🇸🇬🇧", 1);
    expect(result).toBe("🇺🇸");
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it("does not orphan a combining mark from its base letter", () => {
    // "e" + U+0301 (combining acute) renders as "é" and is one grapheme.
    const result = truncateGraphemes("éx", 1);
    expect(result).toBe("é");
    expect(countGraphemes(result)).toBe(1);
  });

  it("reserves room for the ellipsis (result incl. '...' <= max)", () => {
    const result = truncateGraphemes("abcdefghij", 5, { ellipsis: "..." });
    expect(result).toBe("ab...");
    expect(countGraphemes(result)).toBe(5);
    expect(result.endsWith("...")).toBe(true);
  });

  it("reserves only one grapheme for a single-glyph ellipsis '…'", () => {
    const result = truncateGraphemes("abcdefghij", 5, { ellipsis: "…" });
    expect(result).toBe("abcd…");
    expect(countGraphemes(result)).toBe(5);
  });

  it("keeps emoji whole while reserving room for the ellipsis", () => {
    const result = truncateGraphemes("😀😀😀😀😀", 3, { ellipsis: "…" });
    expect(result).toBe("😀😀…");
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(countGraphemes(result)).toBe(3);
  });

  it("does not append an ellipsis when the text already fits", () => {
    expect(truncateGraphemes("abcde", 5, { ellipsis: "..." })).toBe("abcde");
  });

  it("truncates the ellipsis itself when it alone exceeds the limit", () => {
    const result = truncateGraphemes("hello world", 2, { ellipsis: "..." });
    expect(result).toBe("..");
    expect(countGraphemes(result)).toBeLessThanOrEqual(2);
  });
});
