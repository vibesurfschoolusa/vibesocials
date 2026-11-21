/**
 * Grapheme-safe text truncation.
 *
 * Slicing a string by UTF-16 code unit (e.g. `String.prototype.substring`) can
 * cut through the middle of a user-perceived character — splitting an emoji's
 * surrogate pair, tearing a ZWJ sequence (`👨‍👩‍👧`) apart, or orphaning a
 * combining mark from its base letter. The broken half is then an invalid /
 * lone surrogate that platform APIs may reject or render as `�`.
 *
 * These helpers count and cut by EXTENDED GRAPHEME CLUSTER using the built-in
 * `Intl.Segmenter` (UAX #29), so a multi-code-unit grapheme is always kept
 * whole. No dependencies; synchronous.
 */

// A single shared, stateless segmenter. `.segment()` does not mutate it, so one
// instance is safe to reuse across calls (constructing one per call is wasteful).
// Locale is left as the runtime default: extended-grapheme-cluster boundaries
// are not locale-tailored, so the default is correct for every platform here.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Split `text` into its extended grapheme clusters, in order. */
function toGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

/** The number of extended grapheme clusters in `text`. */
export function graphemeCount(text: string): number {
  return toGraphemes(text).length;
}

export interface TruncateOptions {
  /**
   * Suffix appended when (and only when) truncation actually occurs — e.g.
   * `"..."`. Room is reserved for it: the returned string, INCLUDING the
   * ellipsis, is guaranteed to be at most `maxGraphemes` graphemes. The
   * ellipsis is itself measured in graphemes, so a `"…"` (1 grapheme) reserves
   * less room than `"..."` (3).
   */
  ellipsis?: string;
}

/**
 * Truncate `text` to at most `maxGraphemes` user-perceived graphemes without
 * ever splitting one.
 *
 * - If `text` already fits (<= `maxGraphemes` graphemes) it is returned
 *   unchanged and no ellipsis is added.
 * - Otherwise the leading graphemes are kept. With `opts.ellipsis`, enough
 *   trailing graphemes are dropped that `result + ellipsis` still fits within
 *   `maxGraphemes` graphemes.
 * - `maxGraphemes` is clamped to a non-negative integer; `0` (or less) always
 *   yields `""`.
 * - Degenerate case — the ellipsis alone is >= `maxGraphemes` graphemes (so no
 *   content can fit): the ellipsis itself is returned, grapheme-truncated to
 *   `maxGraphemes` so the length guarantee still holds.
 *
 * The invariant `graphemeCount(result) <= maxGraphemes` holds in every case.
 */
export function truncateGraphemes(
  text: string,
  maxGraphemes: number,
  opts?: TruncateOptions,
): string {
  const max = Math.max(0, Math.floor(maxGraphemes));
  if (max === 0) {
    return "";
  }

  const graphemes = toGraphemes(text);
  if (graphemes.length <= max) {
    return text;
  }

  const ellipsis = opts?.ellipsis ?? "";
  if (ellipsis === "") {
    return graphemes.slice(0, max).join("");
  }

  const ellipsisGraphemes = toGraphemes(ellipsis);
  const budget = max - ellipsisGraphemes.length;
  if (budget <= 0) {
    // The ellipsis by itself fills (or overflows) the budget: return it, cut to
    // `max` graphemes so we never exceed the limit.
    return ellipsisGraphemes.slice(0, max).join("");
  }

  return graphemes.slice(0, budget).join("") + ellipsis;
}

const WHITESPACE = /^\s+$/u;

/**
 * `truncateGraphemes` cut at the last whole word that fits (R62
 * platform-clients L1, Instagram): a word, so a #tag or @mention, is never
 * sent in part. Counted in graphemes, with room kept for the ellipsis as
 * `truncateGraphemes` keeps it. Text with no space before the limit keeps the
 * plain grapheme cut. Text that fits comes back unchanged.
 */
export function truncateGraphemesAtWord(text: string, maxGraphemes: number, opts?: TruncateOptions): string {
  const max = Math.max(0, Math.floor(maxGraphemes));
  const graphemes = toGraphemes(text);
  if (graphemes.length <= max) return text;

  const ellipsis = opts?.ellipsis ?? "";
  const budget = max - toGraphemes(ellipsis).length;
  if (budget <= 0) return truncateGraphemes(text, max, opts);

  // The limit falls on a space: the cut already ends a word.
  let end = budget;
  if (!WHITESPACE.test(graphemes[budget])) {
    let space = budget - 1;
    while (space > 0 && !WHITESPACE.test(graphemes[space])) space -= 1;
    if (space > 0) end = space;
  }
  while (end > 0 && WHITESPACE.test(graphemes[end - 1])) end -= 1;
  // Only spaces before the limit: nothing whole to keep, so the plain cut.
  if (end === 0) return truncateGraphemes(text, max, opts);
  return graphemes.slice(0, end).join("") + ellipsis;
}

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

/**
 * Fit text into a title of at most `max` graphemes without cutting it
 * mid-sentence (2026-11-08, YouTube; shared with Pinterest since 2026-11-10): on
 * one line; whole if it fits; else the whole sentences that fit; else one
 * sentence cut at its last whole word, with "…". A single word longer than the
 * limit is cut where it must be, with "…".
 */
export function fitTitle(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (toGraphemes(oneLine).length <= max) return oneLine;

  let fitted = "";
  for (const { segment } of sentenceSegmenter.segment(oneLine)) {
    const next = fitted + segment;
    if (toGraphemes(next.trim()).length > max) break;
    fitted = next;
  }
  if (fitted.trim()) return fitted.trim();

  const cut = truncateGraphemes(oneLine, max, { ellipsis: "…" }).slice(0, -1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** What a cut needs to know about a link it keeps whole. */
export interface TextLink {
  /** Starts with http:// or https://. */
  hasScheme: boolean;
  /** The host starts with "www.". */
  hasWww: boolean;
  /** Has a path, query or fragment after the host. */
  hasPath: boolean;
  /** The host's last label, lower case ("com"). */
  tld: string;
}

/** One piece a cut may not split: a grapheme, or a whole link. */
export interface TextUnit {
  text: string;
  link: TextLink | null;
}

// A link: an optional http(s) scheme, a host of dotted labels ending in letters,
// then an optional path. Narrow on purpose: only ASCII, no brackets or quotes,
// so a cut never takes more than a platform would read as the link. It may not
// follow a word character, "@" (an email address), ".", "-" or "/".
const LINK =
  /(?<![\w@.\-/])(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#][A-Za-z0-9\-._~:/?#@!$&*+,;=%]*)?/gi;
// Punctuation that ends a sentence is not part of the link before it: a link
// keeps only up to its last letter, digit or one of = _ # / - + &.
const LINK_KEEPS = /[A-Za-z0-9=_#/\-+&]/;

/**
 * `link` without its trailing punctuation. R47 pages-a L5: a backward walk to
 * the last kept character, linear in the link. The pattern it replaces
 * (/[^A-Za-z0-9=_#/\-+&]+$/) rescanned to the end from each stripped character,
 * so a long run of them before one kept character cost seconds.
 */
export function trimLinkTrailing(link: string): string {
  let end = link.length;
  while (end > 0 && !LINK_KEEPS.test(link[end - 1])) end -= 1;
  return link.slice(0, end);
}

function linkOf(text: string): TextLink {
  const hasScheme = /^https?:\/\//i.test(text);
  const rest = hasScheme ? text.replace(/^https?:\/\//i, "") : text;
  const host = rest.split(/[/?#:]/, 1)[0];
  return {
    hasScheme,
    hasWww: /^www\./i.test(host),
    hasPath: rest.length > host.length,
    tld: host.slice(host.lastIndexOf(".") + 1).toLowerCase(),
  };
}

/**
 * Split `text` into the pieces a cut may not split (fix round 1, M4/M5):
 * extended grapheme clusters, and links (`https://…`, `www.example.com`,
 * `example.com/path`) as one piece each. Joined back, the pieces are `text`.
 */
export function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  let at = 0;
  const pushGraphemes = (part: string) => {
    for (const grapheme of toGraphemes(part)) units.push({ text: grapheme, link: null });
  };
  for (const match of text.matchAll(LINK)) {
    const link = trimLinkTrailing(match[0]);
    // A match trimmed down to a bare "a.b" with no letters left is not a link.
    if (!/\.[A-Za-z]{2,}/.test(link)) continue;
    pushGraphemes(text.slice(at, match.index));
    units.push({ text: link, link: linkOf(link) });
    at = match.index + link.length;
  }
  pushGraphemes(text.slice(at));
  return units;
}

/**
 * Cut `text` to at most `max` by a platform's own measure (`weigh`, per piece),
 * never splitting a grapheme or a link: the pieces are kept in order while they
 * fit with `ellipsis`, and a piece that does not fit ends the text. Text that
 * already fits comes back unchanged.
 */
export function truncateUnits(
  text: string,
  max: number,
  weigh: (unit: TextUnit) => number,
  ellipsis = "",
): string {
  const measure = (value: string) => textUnits(value).reduce((sum, unit) => sum + weigh(unit), 0);
  const units = textUnits(text);
  if (units.reduce((sum, unit) => sum + weigh(unit), 0) <= max) return text;

  const kept: TextUnit[] = [];
  let used = 0;
  const budget = max - measure(ellipsis);
  for (const unit of units) {
    const weight = weigh(unit);
    if (used + weight > budget) break;
    kept.push(unit);
    used += weight;
  }
  // The ellipsis can join the piece before it (a link that grows), so the
  // joined result is measured again and shortened until it fits.
  let result = kept.map((unit) => unit.text).join("") + ellipsis;
  while (kept.length > 0 && measure(result) > max) {
    kept.pop();
    result = kept.map((unit) => unit.text).join("") + ellipsis;
  }
  return measure(result) <= max ? result : "";
}

/**
 * `truncateGraphemes` that never cuts inside a link: a link that does not fit
 * goes whole (review fix, LinkedIn). Text that fits comes back unchanged.
 */
export function truncateKeepingLinks(text: string, maxGraphemes: number, ellipsis = ""): string {
  return truncateUnits(text, maxGraphemes, (unit) => (unit.link ? graphemeCount(unit.text) : 1), ellipsis);
}
