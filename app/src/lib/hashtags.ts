import { TAG_WORD } from "@/lib/brandVoice";

/**
 * The one hashtag rule (R58 platform-clients L1), read by Instagram's caption
 * fit and YouTube's tags. A tag starts the text or follows a character that
 * cannot be part of a word, so "C#", "issue#4", "&#39;" and "page#frag" are
 * not tags, and letters and digits are any script's, so "#niños" is whole.
 * R59 platform-clients L1: combining marks (\p{M}) belong to the word too:
 * Hindi and Thai vowel signs, and an accent typed as its own character, so
 * "#हिन्दी" and "#café" are whole and no tag starts after a mark.
 */
// R60 platform-clients L1: as twitter-text, the variation selectors U+FE0E and
// U+FE0F (which end "☀️" and "❤️") are the one exception, so "☀️#summer" is a
// tag; and a "#" that U+FE0F or U+20E3 follows is the keycap "#️⃣", not a tag.
const HASHTAG_PATTERN = /(?<=^|[^\p{L}\p{M}\p{N}_&#]|[\uFE0E\uFE0F])#(?![\uFE0F\u20E3])[\p{L}\p{M}\p{N}_]+/gu;

// Every "#" with the word right after it, wherever it stands (no lookbehind).
const SIGN_AND_WORD = /#+([\p{L}\p{M}\p{N}_]*)/gu;

/**
 * R60 new-customer L2: an AI answer without its hashtags' "#" signs. Only a tag
 * whose word has a letter or a mark is one (brandVoice's TAG_WORD), so
 * "#surf" becomes "surf" while "#1" and "#2024" stay; a "#" with no word goes.
 */
export function withoutHashtagSigns(text: string): string {
  return text.replace(SIGN_AND_WORD, (whole, word: string) => (word === "" || TAG_WORD.test(word) ? word : whole));
}

/** Every hashtag in `text`, "#" included, in order, each with its index. */
export function hashtagsIn(text: string): RegExpExecArray[] {
  return [...text.matchAll(HASHTAG_PATTERN)];
}
