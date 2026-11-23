import { describe, expect, it } from "vitest";

import {
  ALT_TEXT_INPUT_MAX,
  ALT_TEXT_MAX,
  ALT_TEXT_TOO_LONG_MESSAGE,
  altTextOf,
  cleanAltText,
  fitAltText,
  isOverlongAltText,
} from "./altText";

describe("cleanAltText", () => {
  it("trims the ends", () => {
    expect(cleanAltText("  A dog on a beach.  ")).toBe("A dog on a beach.");
  });

  it("turns line breaks and tabs into spaces", () => {
    expect(cleanAltText("A dog\non a beach.\r\nIt runs.\rFast.\tVery")).toBe(
      "A dog on a beach. It runs. Fast. Very",
    );
  });

  it("removes other control characters", () => {
    expect(cleanAltText("A\u0000 dog\u0007 on\u007f a\u009b beach.")).toBe("A dog on a beach.");
  });

  it("keeps digits, emoji and letters of every language", () => {
    expect(cleanAltText("Ein Hund am Strand 🐕, 2028 9")).toBe("Ein Hund am Strand 🐕, 2028 9");
  });

  it("turns Unicode line and paragraph separators into spaces", () => {
    expect(cleanAltText(`A${String.fromCharCode(0x2028)}B${String.fromCharCode(0x2029)}C`)).toBe("A B C");
  });

  it("gives an empty string for nothing but whitespace, and for a non-string", () => {
    expect(cleanAltText(" \n\t ")).toBe("");
    expect(cleanAltText(undefined)).toBe("");
    expect(cleanAltText(42)).toBe("");
    expect(cleanAltText(null)).toBe("");
  });

  it("caps the text at 1,000 characters, at a word boundary", () => {
    const words = "word ".repeat(300); // 1,500 characters
    const cleaned = cleanAltText(words);
    expect(ALT_TEXT_MAX).toBe(1000);
    expect(cleaned.length).toBeLessThanOrEqual(1000);
    expect(cleaned.length).toBeGreaterThan(990);
    expect(cleaned.endsWith("word")).toBe(true);
  });

  it("keeps a text of exactly 1,000 characters whole", () => {
    const text = "a".repeat(1000);
    expect(cleanAltText(text)).toBe(text);
  });
});

describe("fitAltText", () => {
  it("returns a text that fits unchanged", () => {
    expect(fitAltText("A dog on a beach.", 500)).toBe("A dog on a beach.");
  });

  it("cuts at the last whole word that fits", () => {
    expect(fitAltText("A dog on a beach.", 10)).toBe("A dog on a");
    expect(fitAltText("A dog on a beach.", 11)).toBe("A dog on a");
  });

  it("cuts a single word longer than the limit where it must", () => {
    expect(fitAltText("Supercalifragilistic", 5)).toBe("Super");
  });

  it("never splits an emoji's surrogate pair", () => {
    const cut = fitAltText("🐕🐕🐕", 3);
    expect(cut).toBe("🐕");
  });
});

describe("altTextOf", () => {
  it("is the item's description cut to the limit, for a photo", () => {
    expect(altTextOf({ mimeType: "image/jpeg", altText: "A dog on a beach." }, 10)).toBe("A dog on a");
  });

  it("is undefined for a photo without one, an empty one, or a video", () => {
    expect(altTextOf({ mimeType: "image/jpeg", altText: null }, 500)).toBeUndefined();
    expect(altTextOf({ mimeType: "image/jpeg", altText: "  " }, 500)).toBeUndefined();
    expect(altTextOf({ mimeType: "image/jpeg" }, 500)).toBeUndefined();
    expect(altTextOf({ mimeType: "video/mp4", altText: "A clip." }, 500)).toBeUndefined();
  });
});

// R67 platform-clients L1: whole graphemes, a word end found at most 100
// graphemes back, never over the bound in UTF-16 units.
describe("fitAltText cuts whole graphemes (R67)", () => {
  const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 8 units, one grapheme

  it("drops the family emoji whole at Pinterest's 500 when it would cross the bound", () => {
    const cut = fitAltText(`${"あ".repeat(498)}${FAMILY}${"い".repeat(50)}`, 500);
    expect(cut).toBe("あ".repeat(498));
  });

  it("keeps the family emoji whole at 500 when it fits", () => {
    const cut = fitAltText(`${"あ".repeat(490)}${FAMILY}${"い".repeat(50)}`, 500);
    expect(cut).toBe(`${"あ".repeat(490)}${FAMILY}${"い".repeat(2)}`);
    expect(cut.length).toBe(500);
  });

  it("keeps the CJK text after \"Photo: \" up to the bound, not just \"Photo:\"", () => {
    const cut = fitAltText(`Photo: ${"写".repeat(800)}`, 500);
    expect(cut).toBe(`Photo: ${"写".repeat(493)}`);
  });

  it("still ends at a word within the look-back", () => {
    expect(fitAltText(`${"word ".repeat(99)}wordwordword`, 500)).toBe(`${"word ".repeat(98)}word`);
  });

  it("stores at 1,000 with the family emoji kept or dropped whole", () => {
    const cleaned = cleanAltText(`${"あ".repeat(998)}${FAMILY}`);
    expect(cleaned).toBe("あ".repeat(998));
  });

  it("is fast at 100k characters", () => {
    const text = `${"写".repeat(50_000)}${"🌊".repeat(25_000)}`;
    const started = performance.now();
    expect(fitAltText(text, 1000).length).toBeLessThanOrEqual(1000);
    expect(cleanAltText(text).length).toBeLessThanOrEqual(1000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// R69 publishing-flow L1: the routes refuse a description over the cap before
// cleaning it, and cleanAltText itself reads no further, as a backstop.
describe("the alt text cap (R69)", () => {
  /** R69: the cleaning took about MEASURED ms alone; ten times that and more. */
  const CLEAN_BUDGET_MS = 500;

  it("is 10,000 characters, like a caption's", () => {
    expect(ALT_TEXT_INPUT_MAX).toBe(10_000);
    expect(isOverlongAltText("a".repeat(10_000))).toBe(false);
    expect(isOverlongAltText("a".repeat(10_001))).toBe(true);
    expect(isOverlongAltText(undefined)).toBe(false);
    expect(isOverlongAltText(["a".repeat(10_001)])).toBe(false);
  });

  it("is refused in plain words", () => {
    expect(ALT_TEXT_TOO_LONG_MESSAGE).toBe("Your photo description is too long: keep it to 1,000 characters.");
  });

  it("cleans 10,000 characters as before", () => {
    const raw = ` A dog\non a beach.\t${"\u0007x ".repeat(5_000)}`.slice(0, 10_000);
    const before = fitAltText(raw.replace(/\r\n|[\r\n\t\v\f\p{Zl}\p{Zp}]/gu, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim(), ALT_TEXT_MAX);
    expect(cleanAltText(raw)).toBe(before);
  });

  it("reads no further than the cap: 2.2M newlines and then words come out empty, fast", () => {
    const raw = `${"\n".repeat(2_200_000)}A dog on a beach.`;
    const started = performance.now();
    expect(cleanAltText(raw)).toBe("");
    expect(performance.now() - started).toBeLessThan(CLEAN_BUDGET_MS);
  }, 10_000);
});
