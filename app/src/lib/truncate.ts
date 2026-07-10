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
