import { textUnits, truncateUnits, type TextLink, type TextUnit } from "@/lib/truncate";

/**
 * X's own count of a post's length (fix round 1, M5), as its twitter-text
 * library counts it, without the library: X refused or cut posts that the old
 * character count said fit.
 *
 * - A code point in X's light ranges weighs 1, any other weighs 2.
 * - An emoji weighs 2, however many code points its sequence has.
 * - A link weighs 23 (X shortens every link to a t.co link), however long.
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

// Endings X links without a scheme or a path. For any other ending X may or may
// not make a link, so such a link is weighed at the larger of the two counts and
// a post is never sent heavier than this count says.
const GENERIC_TLDS = new Set([
  "com", "net", "org", "info", "biz", "edu", "gov", "app", "dev", "shop", "store",
  "online", "site", "blog", "xyz", "club", "surf", "co", "tv",
]);

function codePointWeight(codePoint: number): number {
  return LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 1 : 2;
}

function charactersWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += codePointWeight(char.codePointAt(0)!);
  return weight;
}

function surelyLinked(link: TextLink): boolean {
  return GENERIC_TLDS.has(link.tld) || (link.tld.length === 2 && (link.hasScheme || link.hasPath));
}

function unitWeight(unit: TextUnit): number {
  if (unit.link) {
    return surelyLinked(unit.link) ? X_LINK_WEIGHT : Math.max(X_LINK_WEIGHT, charactersWeight(unit.text));
  }
  return EMOJI.test(unit.text) ? 2 : charactersWeight(unit.text);
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
