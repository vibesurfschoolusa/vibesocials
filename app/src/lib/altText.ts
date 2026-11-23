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

/**
 * R69 publishing-flow L1: the longest description a route takes, like a
 * caption's cap (MAX_CAPTION_CHARS). Cleaning 2.2M newlines cost 0.2-0.4 s of
 * CPU, so a longer one is refused before it is cleaned. Create sends at most
 * ALT_TEXT_MAX, so only a crafted request reaches this.
 */
export const ALT_TEXT_INPUT_MAX = 10_000;

/** The 400 for a description over ALT_TEXT_INPUT_MAX; it names what is kept. */
export const ALT_TEXT_TOO_LONG_MESSAGE = `Your photo description is too long: keep it to ${ALT_TEXT_MAX.toLocaleString("en-US")} characters.`;

/** True for text longer than ALT_TEXT_INPUT_MAX, read by length alone. */
export function isOverlongAltText(raw: unknown): boolean {
  return typeof raw === "string" && raw.length > ALT_TEXT_INPUT_MAX;
}

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
  // R69: a backstop for the routes' refusal; nothing past the cap is ever kept
  // (the result is at most ALT_TEXT_MAX), so it is not read.
  const bounded = isOverlongAltText(raw) ? truncateUtf16AtWord(raw, ALT_TEXT_INPUT_MAX) : raw;
  const cleaned = bounded.replace(LINE_BREAKS, " ").replace(CONTROL_CHARACTERS, "").trim();
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
