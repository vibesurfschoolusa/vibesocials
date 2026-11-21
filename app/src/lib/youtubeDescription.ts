import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateUnitsAtWord } from "@/lib/truncate";

/**
 * YouTube's video description rule, in one client-safe place (R52
 * platform-clients L1): youtubeClient.ts posts with it and the composer's
 * preview and counter (lib/platformPreview.ts, lib/platformOverrides.ts) cut
 * and count with it, so what is shown can't differ from what is sent.
 */

const { utf8ByteLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.youtube;

/** YouTube's limit on a video description, in UTF-8 bytes. */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = utf8ByteLimit as number;

/**
 * YouTube refuses "<" and ">" in a title or a description (fix round 1, M4), so
 * they become the single angle quotes, which read the same ("<3" -> "‹3").
 */
export function youtubeSafeText(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/** The description's length as YouTube counts it: UTF-8 bytes, after the angle quotes. */
export function youtubeDescriptionLength(caption: string): number {
  return utf8Length(youtubeSafeText(caption));
}

/**
 * The description: the caption with safe angle quotes, cut to YouTube's 5,000
 * bytes with "…" when it is longer, never inside a character or a link, and at
 * a whole word (R64 platform-clients L1).
 */
export function fitYouTubeDescription(caption: string): string {
  return truncateUnitsAtWord(
    youtubeSafeText(caption),
    YOUTUBE_DESCRIPTION_MAX_BYTES,
    (unit) => utf8Length(unit.text),
    ellipsis,
  );
}

/**
 * Why YouTube's count runs ahead of the letters a person sees, or `null` when
 * every character counts as one. A plain hint instead of the word "bytes".
 *
 * R52 fix review L1: a short sentence, true for any text that shows it. Any
 * non-ASCII character counts 2 or more: an accented letter 2 or 3, a curly
 * quote 3, an emoji 3 or more (a wave 4, a flag 8, a joined family 25); a <
 * or > counts 3 once swapped for its angle quote.
 */
export function youtubeCountHint(text: string): string | null {
  const wide = /\P{ASCII}/u.test(text);
  const angle = /[<>]/.test(text);
  if (wide && angle) return "YouTube counts accented letters, curly quotes, emoji, < and > as 2 or more.";
  if (wide) return "YouTube counts accented letters, curly quotes and emoji as 2 or more.";
  return angle ? "YouTube counts < and > as 3." : null;
}
