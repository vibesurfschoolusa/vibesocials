import { hashtagsIn } from "@/lib/hashtags";

const MENTION = /(^|[\s([{])@([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
const MENTION_TOKEN = /^@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*[,;]*$/;
// Characters people put between footer tags: "#surf · @kai | @mia, @ana".
const SEPARATOR_TOKEN = /^[·•|,;/–—-]+$/;

function isHashtagToken(token: string): boolean {
  const bare = token.replace(/[,;]+$/, "");
  return hashtagsIn(bare)[0]?.[0] === bare;
}

/**
 * A footer-style line: mentions and hashtags alone, with whitespace and
 * separators between them, and at least one mention. Any other word makes it
 * running text.
 */
function isTagLine(tokens: readonly string[]): boolean {
  return (
    tokens.some((token) => MENTION_TOKEN.test(token)) &&
    tokens.every((token) => MENTION_TOKEN.test(token) || isHashtagToken(token) || SEPARATOR_TOKEN.test(token))
  );
}

/** The footer line without its mentions; separators are kept only between two hashtags. */
function withoutMentions(tokens: readonly string[]): string {
  const kept: string[] = [];
  let separator: string | null = null;
  for (const token of tokens) {
    if (MENTION_TOKEN.test(token)) continue;
    if (SEPARATOR_TOKEN.test(token)) {
      separator ??= token;
      continue;
    }
    if (separator !== null && kept.length > 0) kept.push(separator);
    separator = null;
    kept.push(token);
  }
  return kept.join(" ").replace(/[,;]+$/, "");
}

function removeLineMentions(line: string): string {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (isTagLine(tokens)) return withoutMentions(tokens) + (line.endsWith("\r") ? "\r" : "");
  return line.replace(MENTION, "$1$2");
}

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
 * (`@vibesurfschool.za`) count as one. An email address (`info@example.com`)
 * is not a mention and is kept.
 *
 * R59 new-customer-2 L2: deleting a handle from a sentence left "surf with ."
 * on a client's public post. In running text only the "@" goes ("with
 * vibesurfschool."), which X doesn't read as a mention. Whole handles go only
 * on a line of mentions and hashtags alone, like the caption footer, and that
 * line's hashtags stay. The spaces and empty lines a removal leaves behind are
 * tidied; everything else stays as written.
 */
export function removeXMentions(text: string): string {
  if (!text.includes("@")) return text;
  return text
    .split("\n")
    .map(removeLineMentions)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
