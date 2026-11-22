/**
 * Alt text (07d): the description a screen reader speaks for a photo. Written
 * once per photo on the Create page, stored as `MediaItem.altText`, and sent to
 * every platform that takes one, each cut to its own limit.
 *
 * Pure: shared by the Create page, POST /api/posts and the platform clients.
 */

import { truncateUtf16AtWord } from "@/lib/truncate";

/** The most the app stores: X's limit, the largest of the platforms' that we confirmed. */
export const ALT_TEXT_MAX = 1000;

// Line breaks and tabs become spaces: every platform shows alt text on one line.
// Zl and Zp are the Unicode line and paragraph separators.
const LINE_BREAKS = /\r\n|[\r\n\t\v\f\p{Zl}\p{Zp}]/gu;
// C0 and C1 control characters; whitespace among them was already replaced above.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Cut `text` to at most `max` UTF-16 code units (the strictest way a platform
 * may count), in whole graphemes, at the last word end within 100 graphemes
 * of the bound. R67 platform-clients L1: a code-point cut sent half a family
 * emoji, and an unbounded look-back cut "Photo: " plus a long run of Japanese
 * to "Photo:".
 */
export function fitAltText(text: string, max: number): string {
  return truncateUtf16AtWord(text, max);
}

/**
 * The description as stored: trimmed, line breaks turned into spaces, control
 * characters removed, at most {@link ALT_TEXT_MAX} characters. "" for nothing
 * (or for anything that is not a string).
 */
export function cleanAltText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(LINE_BREAKS, " ").replace(CONTROL_CHARACTERS, "").trim();
  return fitAltText(cleaned, ALT_TEXT_MAX);
}

/**
 * What a client sends for this file: its stored description cut to the
 * platform's `limit`, or undefined when there is none or the file is a video
 * (then the request must stay exactly as it was before alt text existed).
 */
export function altTextOf(
  item: { mimeType?: string | null; altText?: string | null },
  limit: number,
): string | undefined {
  if (!item.mimeType?.startsWith("image/")) return undefined;
  const text = cleanAltText(item.altText);
  return text ? fitAltText(text, limit) : undefined;
}
