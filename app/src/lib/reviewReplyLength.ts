/**
 * How long a Google review reply may be (R17-client-journey addendum L1).
 *
 * Google's ReviewReply.comment: "The maximum length is 4096 bytes." (lead
 * checked Google's docs, 2026-11-15). Over it Google answers 400 and the reply
 * can never post, so the reply route and the reply box both use this one rule.
 * Measured on the trimmed text, which is what the route sends.
 */
export const GOOGLE_REPLY_MAX_BYTES = 4096;

/** From here on the reply box shows how much of the limit is used. */
export const REPLY_COUNTER_FROM_BYTES = 3600;

export const REPLY_TOO_LONG_MESSAGE =
  "Your reply is too long for Google. Google allows 4,096 bytes, about 4,000 characters (emoji and accented letters count more). Shorten it and try again.";

const encoder = new TextEncoder();

export function replyBytes(text: string): number {
  return encoder.encode(text.trim()).length;
}

export function replyTooLong(text: string): boolean {
  return replyBytes(text) > GOOGLE_REPLY_MAX_BYTES;
}

/** The counter line under the reply box, or null while the reply is well under the limit. */
export function replyCounter(text: string): string | null {
  const bytes = replyBytes(text);
  if (bytes < REPLY_COUNTER_FROM_BYTES) return null;
  return `${bytes.toLocaleString("en-US")} of ${GOOGLE_REPLY_MAX_BYTES.toLocaleString("en-US")} bytes used. Emoji and accented letters count more.`;
}
