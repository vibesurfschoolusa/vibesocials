import { describe, expect, it } from "vitest";

import {
  graphemeCount,
  textUnits,
  trimLinkTrailing,
  truncateGraphemes,
  truncateGraphemesWithinCodePoints,
  truncateGraphemesAtWord,
  truncateKeepingLinks,
  truncateKeepingLinksAtWord,
  truncateUnits,
  truncateUnitsAtWord,
  truncateUtf16AtWord,
} from "./truncate";
import { buildCaptionWithFooter } from "./captionFooter";
import { platformCaptionCounter } from "./platformOverrides";
import { PLATFORM_CAPTION_LIMITS } from "./platformLimits";
import { buildPlatformPreview } from "./platformPreview";

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

// Fix round 1 (M4, M5): links are kept whole when a text is cut.
// R62 platform-clients L1: Instagram's cut, never inside a #tag or @mention.
describe("truncateGraphemesAtWord", () => {
  it("returns text that fits unchanged", () => {
    expect(truncateGraphemesAtWord("Dawn patrol #surf", 17)).toBe("Dawn patrol #surf");
  });

  it("cuts at the last whole word that fits, so a tag or mention is never split", () => {
    expect(truncateGraphemesAtWord("Dawn patrol #surfschool", 15)).toBe("Dawn patrol");
    expect(truncateGraphemesAtWord("Thanks @surfer21", 15)).toBe("Thanks");
  });

  it("keeps the whole cut when the limit falls on a space", () => {
    expect(truncateGraphemesAtWord("Dawn patrol #surf", 11)).toBe("Dawn patrol");
    expect(truncateGraphemesAtWord("Dawn\n\n#surf", 5)).toBe("Dawn");
  });

  it("with no space before the limit, keeps the plain grapheme cut", () => {
    expect(truncateGraphemesAtWord("a".repeat(30), 20)).toBe("a".repeat(20));
    expect(truncateGraphemesAtWord(`${"a".repeat(30)} b`, 20)).toBe("a".repeat(20));
  });

  it("counts graphemes, never splitting an emoji sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(truncateGraphemesAtWord(`${family} ${family} ${family}`, 4)).toBe(`${family} ${family}`);
  });

  // R62 review low 1: a word boundary more than 100 graphemes back is not looked for.
  it("a space more than 100 graphemes before the limit keeps the plain grapheme cut", () => {
    expect(truncateGraphemesAtWord(`ab ${"c".repeat(200)}`, 103)).toBe(`ab ${"c".repeat(100)}`);
    expect(truncateGraphemesAtWord(`ab ${"c".repeat(200)}`, 102)).toBe("ab");
  });

  it("reserves room for an ellipsis", () => {
    expect(truncateGraphemesAtWord("Dawn patrol #surfschool", 15, { ellipsis: "…" })).toBe("Dawn patrol…");
  });
});

// R63 platform-clients L1: LinkedIn's cut, never inside a #tag or @mention, and
// still never inside a link.
describe("truncateUnitsAtWord and truncateKeepingLinksAtWord", () => {
  const byGrapheme = (unit: { text: string; link: unknown }) => (unit.link ? graphemeCount(unit.text) : 1);

  it("returns text that fits unchanged", () => {
    expect(truncateKeepingLinksAtWord("Dawn patrol #surf", 17, "...")).toBe("Dawn patrol #surf");
  });

  it("cuts at the last whole word, so a mention is never split", () => {
    expect(truncateKeepingLinksAtWord("Thanks @surfer21 today", 16, "...")).toBe("Thanks...");
  });

  it("cuts at the last whole word, so a hashtag is never split", () => {
    expect(truncateKeepingLinksAtWord("Dawn patrol #surfschool tail", 20, "...")).toBe("Dawn patrol...");
  });

  it("a link at the cut stays whole, and goes with its word", () => {
    expect(truncateKeepingLinksAtWord("Book at https://vibesurfschool.com/lessons now", 30, "...")).toBe("Book at...");
    expect(truncateKeepingLinksAtWord("Book https://vibesurfschool.com/a now", 36, "...")).toBe(
      "Book https://vibesurfschool.com/a...",
    );
  });

  it("with no space in the 100 graphemes before the limit, keeps the plain cut", () => {
    const script = "あ".repeat(300);
    expect(truncateKeepingLinksAtWord(script, 200, "...")).toBe(truncateKeepingLinks(script, 200, "..."));
    expect(truncateUnitsAtWord(`ab ${"c".repeat(200)}`, 103, byGrapheme)).toBe(`ab ${"c".repeat(100)}`);
    expect(truncateUnitsAtWord(`ab ${"c".repeat(200)}`, 102, byGrapheme)).toBe("ab");
  });

  it("is as truncateUnits when the cut already ends a word", () => {
    expect(truncateUnitsAtWord("Dawn patrol #surf", 11, byGrapheme)).toBe("Dawn patrol");
    expect(truncateUnits("Dawn patrol #surf", 11, byGrapheme)).toBe("Dawn patrol");
  });

  it("takes under 1 s at 10k and 40k characters", () => {
    for (const size of [10_000, 40_000]) {
      for (const text of [
        "Thanks @surfer21 #surfschool https://vibesurfschool.com/a ".repeat(size / 58),
        "a".repeat(size),
        " ".repeat(size),
        "vibesurfschool.com/".repeat(size / 19),
      ]) {
        const started = performance.now();
        truncateKeepingLinksAtWord(text, 3000, "...");
        expect(performance.now() - started).toBeLessThan(1000);
      }
    }
  });
});

describe("textUnits", () => {
  it("splits text into graphemes and whole links", () => {
    const units = textUnits("Hi \u{1F30A} https://example.com/a?b=1. ok");
    expect(units.map((u) => u.text)).toEqual([
      "H", "i", " ", "\u{1F30A}", " ", "https://example.com/a?b=1", ".", " ", "o", "k",
    ]);
    expect(units[5].link).toEqual({ hasScheme: true, hasWww: false, hasPath: true, tld: "com" });
    expect(units[0].link).toBeNull();
  });

  it("finds bare domains but not email addresses", () => {
    expect(textUnits("www.example.com").map((u) => u.text)).toEqual(["www.example.com"]);
    expect(textUnits("a@b.com").every((u) => u.link === null)).toBe(true);
  });

  it("joins back to the text it came from", () => {
    const text = "Café \u{1F468}‍\u{1F469}‍\u{1F467} example.com/x (www.a.org) end";
    expect(textUnits(text).map((u) => u.text).join("")).toBe(text);
  });
});

describe("truncateUnits", () => {
  const bytes = (unit: { text: string }) => new TextEncoder().encode(unit.text).length;

  it("returns text within the limit unchanged", () => {
    expect(truncateUnits("abc", 3, bytes, "…")).toBe("abc");
  });

  it("cuts by the given weight with room for the ellipsis", () => {
    expect(truncateUnits("abcdef", 5, bytes, "…")).toBe("ab…");
  });

  it("drops a link that does not fit whole", () => {
    expect(truncateUnits("ab https://example.com/x", 20, bytes, "")).toBe("ab ");
  });
});

// R47 pages-a L5: the link-trailing trim runs in linear time. The old
// /[^A-Za-z0-9=_#/\-+&]+$/ rescanned to the end from each stripped character,
// so a long run of them before one kept character cost seconds on every
// keystroke of X's preview. A missing fix is a quick red test.
describe("trimLinkTrailing", () => {
  const OLD_LINK_TRAILING = /[^A-Za-z0-9=_#/\-+&]+$/;

  it.each([10_000, 40_000])("a link with %i stripped characters before one kept one: under 20 ms", (n) => {
    const text = `example.com/${"!".repeat(n)}a`;
    const started = performance.now();
    const units = textUnits(text);
    expect(performance.now() - started).toBeLessThan(20);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
  }, 5_000);

  it("strips exactly what the old pattern stripped, on a few hundred varied links", () => {
    const bases = ["example.com", "https://example.com/a", "www.surf.co/path?q=1", "a.io/x#top", "b.dev/p+q&r"];
    const tails = [".", ")", "!", "%", "&", ",", ";", ":", "~", "@", "'", "?", "-", "_", "=", "/", "#", "+", "a", "9", "é", "…"];
    let compared = 0;
    for (const base of bases) {
      for (const first of tails) {
        for (const second of ["", ...tails.slice(0, 12)]) {
          const link = `${base}${first}${second}`;
          expect(trimLinkTrailing(link)).toBe(link.replace(OLD_LINK_TRAILING, ""));
          compared += 1;
        }
      }
    }
    for (const edge of ["", "!!!", "a", "...a...", "x.co/!!&!!", "x.co/%%%", "x.co/a)."]) {
      expect(trimLinkTrailing(edge)).toBe(edge.replace(OLD_LINK_TRAILING, ""));
    }
    expect(compared).toBeGreaterThan(300);
  });
});

// R65 platform-clients (unconfirmed; TikTok's docs confirm it): TikTok counts its
// title in UTF-16 units, so its cut counts them, at a whole word, never
// splitting a grapheme or a surrogate pair.
describe("truncateUtf16AtWord", () => {
  const segments = (text: string) =>
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);

  it("plain ASCII at the limit comes back unchanged", () => {
    const text = "a".repeat(2200);
    expect(truncateUtf16AtWord(text, 2200)).toBe(text);
  });

  it("2,150 graphemes with 100 emoji (2,250 units) is cut to 2,200 units or fewer, at a whole word", () => {
    let text = "";
    for (let i = 0; i < 100; i += 1) text += "\u{1F30A} ";
    while (segments(text).length < 2150) text += "surf ";
    text = text.trimEnd() + "s";
    expect(segments(text)).toHaveLength(2150);
    expect(text.length).toBeGreaterThan(2200);
    const cut = truncateUtf16AtWord(text, 2200);
    expect(cut.length).toBeLessThanOrEqual(2200);
    expect(text.startsWith(cut)).toBe(true);
    expect(text[cut.length]).toBe(" ");
    expect(cut.endsWith("surf")).toBe(true);
  });

  it("never splits a surrogate pair or a joined family at the limit", () => {
    for (const piece of ["\u{1F30A}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F1FA}\u{1F1F8}", "e\u0301"]) {
      for (const max of [9, 10, 11, 12, 13]) {
        const cut = truncateUtf16AtWord(piece.repeat(20), max);
        expect(cut.length).toBeLessThanOrEqual(max);
        expect(cut.isWellFormed()).toBe(true);
        expect(segments(cut).every((g) => g === piece)).toBe(true);
      }
    }
  });

  it("text with no space in the 100 graphemes before the limit keeps the plain unit cut", () => {
    expect(truncateUtf16AtWord("\u{1F30A}".repeat(300), 201)).toBe("\u{1F30A}".repeat(100));
  });

  it("keeps room for an ellipsis, counted in units", () => {
    const cut = truncateUtf16AtWord("surf waves ".repeat(30), 50, { ellipsis: "..." });
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut).toMatch(/(surf|waves)\.\.\.$/);
  });
});

// R66 (lead): a cut that keeps whole graphemes AND stays within a size bound,
// for input with no other cap. A grapheme that would cross the bound is dropped
// whole, so one letter with any number of combining marks can't exceed it.
describe("truncateGraphemesWithinCodePoints", () => {
  const codePoints = (text: string) => [...text].length;

  it("plain ASCII: unchanged when it fits, cut to the bound when not", () => {
    expect(truncateGraphemesWithinCodePoints("Dawn patrol", 11)).toBe("Dawn patrol");
    expect(truncateGraphemesWithinCodePoints("a".repeat(300), 200)).toBe("a".repeat(200));
  });

  it("an emoji at the bound is kept whole when it fits, dropped whole when it doesn't", () => {
    const flag = "\u{1F1FA}\u{1F1F8}";
    expect(truncateGraphemesWithinCodePoints(`${"a".repeat(8)}${flag}b`, 10)).toBe(`${"a".repeat(8)}${flag}`);
    expect(truncateGraphemesWithinCodePoints(`${"a".repeat(9)}${flag}b`, 10)).toBe("a".repeat(9));
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(truncateGraphemesWithinCodePoints(`${"a".repeat(7)}${family}`, 10)).toBe("a".repeat(7));
  });

  it("a 10,000-combining-mark grapheme stays within the bound", () => {
    const heavy = `a${"́".repeat(10_000)}`;
    const cut = truncateGraphemesWithinCodePoints(`ok ${heavy} done`, 200);
    expect(codePoints(cut)).toBeLessThanOrEqual(200);
    expect(cut).toBe("ok ");
    expect(truncateGraphemesWithinCodePoints(heavy, 200)).toBe("");
  });

  it("a bound of 0 or less gives an empty string", () => {
    expect(truncateGraphemesWithinCodePoints("abc", 0)).toBe("");
  });
});

// R68 platform-clients L2: the link pattern can end a link inside a grapheme
// ("vibesurf.com/1" + the keycap's U+FE0F U+20E3, or "cafe" + U+0301). The
// marks then became a piece of their own, so LinkedIn's cut counted one more
// than its grapheme counter, and a caption the counter said fits was cut.
describe("LinkedIn: a link that ends inside a grapheme", () => {
  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.linkedin;
  const limit = charLimit ?? 0;
  const cut = (text: string) => truncateKeepingLinksAtWord(text, limit, ellipsis);
  const keycap = "Steps at vibesurf.com/1️⃣";
  const cafe = "Steps at vibesurf.com/café";

  it.each([
    ["a keycap", keycap],
    ["a decomposed café", cafe],
  ])("3,000 graphemes ending in %s: the counter and the cut agree", (_name, tail) => {
    const pad = "wave ".repeat(Math.floor((limit - countGraphemes(tail)) / 5));
    const text = `${pad}${"a".repeat(limit - countGraphemes(tail) - pad.length)}${tail}`;
    expect(countGraphemes(text)).toBe(limit);
    const counter = platformCaptionCounter(text, "linkedin", null);
    const preview = buildPlatformPreview({ platform: "linkedin", caption: text });
    expect(counter.over).toBe(false);
    expect(cut(text)).toBe(text);
    expect(preview.rendered).toBe(text);
    expect(preview.truncated).toBe(preview.willTruncate);
    // One more grapheme: both say over, and the cut still fits.
    const over = `b${text}`;
    expect(platformCaptionCounter(over, "linkedin", null).over).toBe(true);
    expect(cut(over)).not.toBe(over);
    expect(countGraphemes(cut(over))).toBeLessThanOrEqual(limit);
  });

  it("the footer rule agrees: a footer kept at exactly 3,000 graphemes is not cut", () => {
    const user = { companyWebsite: "vibesurfschool.com" };
    const footer = "For more info visit vibesurfschool.com";
    const baseLength = limit - countGraphemes(`\n\n${footer}`);
    const pad = "wave ".repeat(Math.floor((baseLength - countGraphemes(keycap)) / 5));
    const base = `${pad}${"a".repeat(baseLength - countGraphemes(keycap) - pad.length)}${keycap}`;
    const full = buildCaptionWithFooter(base, user, "linkedin");
    expect(full).toBe(`${base}\n\n${footer}`);
    expect(countGraphemes(full)).toBe(limit);
    expect(cut(full)).toBe(full);
  });

  it("the pieces' weights add up to the text's graphemes", () => {
    for (const text of [keycap, cafe, `${keycap} and ${cafe}`, "x.co/á́̂ ok", "a.io/\u{1F44D}\u{1F3FB}"]) {
      const units = textUnits(text, { wholeGraphemes: true });
      expect(units.map((unit) => unit.text).join("")).toBe(text);
      expect(units.reduce((sum, unit) => sum + countGraphemes(unit.text), 0)).toBe(countGraphemes(text));
      expect(units.every((unit) => unit.link !== null || countGraphemes(unit.text) === 1)).toBe(true);
    }
    expect(textUnits(keycap, { wholeGraphemes: true }).at(-1)).toMatchObject({ text: "vibesurf.com/1️⃣" });
  });

  it("plain links: as now", () => {
    const text = "Book at https://vibesurf.com/book?x=1. Or www.surf.co, then a.io/p ok";
    const before = textUnits(text);
    expect(textUnits(text, { wholeGraphemes: true })).toEqual(before);
    expect(before.filter((unit) => unit.link).map((unit) => unit.text)).toEqual([
      "https://vibesurf.com/book?x=1",
      "www.surf.co",
      "a.io/p",
    ]);
    // X keeps its own split: the keycap's marks stay a piece, as twitter-text counts them.
    expect(textUnits(keycap).map((unit) => unit.text).slice(-2)).toEqual(["vibesurf.com/1", "️⃣"]);
    const long = `${"wave ".repeat(598)}see vibesurf.com/book now`;
    expect(cut(long)).toBe(`${"wave ".repeat(598)}see...`);
  });
});
