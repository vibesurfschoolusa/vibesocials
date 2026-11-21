/**
 * The one hashtag rule (R58 platform-clients L1), read by Instagram's caption
 * fit and YouTube's tags. A tag starts the text or follows a character that
 * cannot be part of a word, so "C#", "issue#4", "&#39;" and "page#frag" are
 * not tags, and letters and digits are any script's, so "#niños" is whole.
 */
const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;

/** Every hashtag in `text`, "#" included, in order, each with its index. */
export function hashtagsIn(text: string): RegExpExecArray[] {
  return [...text.matchAll(HASHTAG_PATTERN)];
}
