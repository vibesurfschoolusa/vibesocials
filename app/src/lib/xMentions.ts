/**
 * Removes @-mentions from the text of an X post.
 *
 * Since 2026-02-23 X restricts programmatically @-mentioning users from
 * self-serve API tiers, which includes pay-per-use ("Addressing LLM-generated
 * spam", https://docs.x.com/changelog). A post from this app that mentioned
 * accounts was refused with 403 "You are not permitted to perform this action"
 * (live post, 2026-11-08), because the caption footer tags many accounts.
 * Only the X text changes: other platforms keep their mentions.
 *
 * A mention is an `@` at the start of the text or after whitespace or an
 * opening bracket, followed by a handle; dotted Instagram-style handles
 * (`@vibesurfschool.za`) go as a whole. An email address (`info@example.com`)
 * is not a mention and is kept. The spaces and empty lines a removal leaves
 * behind are tidied; hashtags and everything else stay as written.
 */
export function removeXMentions(text: string): string {
  if (!text.includes("@")) return text;
  return text
    .replace(/(^|[\s([{])@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
