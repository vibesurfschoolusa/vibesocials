import { describe, expect, it } from "vitest";

import { truncateGraphemes } from "@/lib/truncate";

import { computeTweetText } from "./xClient";

// Roadmap Phase 7 (spec §7.1) — this locks computeTweetText (extracted from
// publishVideo when it was refactored to read its limit/ellipsis from
// lib/platformLimits.ts instead of inline `280` / `"..."` literals) to the
// EXACT same output as the pre-refactor inline block:
//
//   let tweetText = caption;
//   if (tweetText.length > 280) {
//     const truncated = truncateGraphemes(tweetText, 280, { ellipsis: "..." });
//     if (truncated !== tweetText) tweetText = truncated;
//   }
//
// If this ever fails, either the refactor broke posting behavior or someone
// edited PLATFORM_CAPTION_LIMITS.x without meaning to change what X posts.
describe("computeTweetText", () => {
  it("returns a caption under 280 graphemes unchanged", () => {
    const caption = "Just a short caption";
    expect(computeTweetText(caption)).toBe(caption);
  });

  it("returns a caption at exactly 280 graphemes unchanged (boundary)", () => {
    const caption = "a".repeat(280);
    expect(computeTweetText(caption)).toBe(caption);
  });

  it("truncates a caption of length 300 to 280 graphemes with a '...' ellipsis", () => {
    const caption = "a".repeat(300);
    const result = computeTweetText(caption);
    expect(result).toHaveLength(280);
    expect(result).toBe("a".repeat(277) + "...");
  });

  it("matches the pre-refactor inline call byte-for-byte for a realistic long caption", () => {
    const caption = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    expect(caption.length).toBeGreaterThan(280);
    expect(computeTweetText(caption)).toBe(
      truncateGraphemes(caption, 280, { ellipsis: "..." }),
    );
  });

  it("matches the pre-refactor inline call byte-for-byte for emoji/ZWJ-heavy content over the limit", () => {
    // Astral (surrogate-pair) graphemes are exactly where a re-implementation
    // could diverge from the original `.length > 280` UTF-16 pre-check.
    const caption = "😀👨‍👩‍👧🇺🇸".repeat(60);
    expect(caption.length).toBeGreaterThan(280);
    expect(computeTweetText(caption)).toBe(
      truncateGraphemes(caption, 280, { ellipsis: "..." }),
    );
  });

  it("empty caption stays empty (no crash, no spurious ellipsis)", () => {
    expect(computeTweetText("")).toBe("");
  });
});
