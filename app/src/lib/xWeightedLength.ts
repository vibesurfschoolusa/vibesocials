import { textUnits, truncateUnits, type TextLink, type TextUnit } from "@/lib/truncate";

/**
 * X's own count of a post's length (fix round 1, M5), as its twitter-text
 * library counts it, without the library: X refused or cut posts that the old
 * character count said fit.
 *
 * - A code point in X's light ranges weighs 1, any other weighs 2.
 * - An emoji weighs 2, however many code points its sequence has.
 * - A link weighs 23 (X shortens every link to a t.co link), however long:
 *   http(s):// always, a bare domain when it starts with www. or has a listed ending.
 */

/** X's limit on a post's weight. */
export const X_MAX_WEIGHT = 280;
/** The weight of every link: the length of X's t.co link. */
export const X_LINK_WEIGHT = 23;

const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// A keycap (digit, # or * + U+FE0F + U+20E3) is one emoji with no
// Extended_Pictographic code point (review fix).
const KEYCAP = /^[0-9#*]\uFE0F\u20E3$/u;

// Endings a bare domain (no http(s)://, no www.) must have to count as a link
// (lead's rule, fix round 1). Other dotted words ("Mr.Smith", "notes.txt") are
// counted as characters.
const LINK_TLDS = new Set([
  "com", "net", "org", "io", "co", "us", "uk", "de", "fr", "es", "it", "nl", "ca", "au", "za",
  "info", "biz", "app", "dev", "me", "ly", "tv", "wtf", "shop", "store", "online", "site", "xyz", "ai",
]);

function codePointWeight(codePoint: number): number {
  return LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 1 : 2;
}

function charactersWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += codePointWeight(char.codePointAt(0)!);
  return weight;
}

function countsAsLink(link: TextLink): boolean {
  return link.hasScheme || link.hasWww || LINK_TLDS.has(link.tld);
}

function unitWeight(unit: TextUnit): number {
  if (unit.link) {
    return countsAsLink(unit.link) ? X_LINK_WEIGHT : charactersWeight(unit.text);
  }
  return EMOJI.test(unit.text) || KEYCAP.test(unit.text) ? 2 : charactersWeight(unit.text);
}

/** The weight X gives `text`. */
export function xWeightedLength(text: string): number {
  return textUnits(text).reduce((sum, unit) => sum + unitWeight(unit), 0);
}

/**
 * Cut `text` to at most `max` by X's weight, with `ellipsis` when it is cut.
 * Never splits an emoji, any other character, or a link.
 */
export function truncateXWeighted(text: string, max: number, ellipsis = ""): string {
  return truncateUnits(text, max, unitWeight, ellipsis);
}
