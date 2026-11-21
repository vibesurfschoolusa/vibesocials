import { hashtagsIn } from "@/lib/hashtags";
import { X_LINK_WEIGHT, xWeightedLength } from "@/lib/xWeightedLength";

const MENTION = /(^|[\s([{])@([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
const MENTION_TOKEN = /^@[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*[,;]*$/;
// Characters people put between footer tags: "#surf · @kai | @mia, @ana".
const SEPARATOR_TOKEN = /^[·•|,;/–—-]+$/;
// Longer than X's link weight, so the padded name weighs X_LINK_WEIGHT only
// when X counts it as a link.
const LINK_PROBE = `${"a".repeat(X_LINK_WEIGHT + 7)}.`;

function isHashtagToken(token: string): boolean {
  const bare = token.replace(/[,;]+$/, "");
  return hashtagsIn(bare)[0]?.[0] === bare;
}

function tokensOf(line: string): string[] {
  return line.split(/\s+/).filter(Boolean);
}

/** A line made only of mentions, hashtags and the separators between them. */
function isTagLine(tokens: readonly string[]): boolean {
  return tokens.every((token) => MENTION_TOKEN.test(token) || isHashtagToken(token) || SEPARATOR_TOKEN.test(token));
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

/**
 * The name a mention in running text leaves. R59 fix review L2: a dotted name
 * that X would count as a link ("vibesurfschool.za", "surf.co") keeps only the
 * part before its first dot, so the post never carries a link nobody wrote.
 * The test is xWeightedLength's own, on the name behind a long label.
 */
function bareName(name: string): string {
  if (!name.includes(".")) return name;
  return xWeightedLength(LINK_PROBE + name) === X_LINK_WEIGHT ? name.slice(0, name.indexOf(".")) : name;
}

function inRunningText(line: string): string {
  return line.replace(MENTION, (_whole, before: string, name: string) => before + bareName(name));
}

/** One paragraph's lines: a footer paragraph loses its mentions whole, any other only their "@". */
function paragraphWithoutMentions(lines: readonly string[]): string[] {
  const tokens = lines.map(tokensOf);
  const isFooter =
    tokens.some((line) => line.some((token) => MENTION_TOKEN.test(token))) && tokens.every(isTagLine);
  if (!isFooter) return lines.map(inRunningText);
  return lines.map((line, index) => withoutMentions(tokens[index]) + (line.endsWith("\r") ? "\r" : ""));
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
 * vibesurfschool"), which X doesn't read as a mention. Whole handles go only
 * in the footer: a paragraph of its own (between blank lines, or at the start
 * or end) whose every line is mentions, hashtags and separators alone. Its
 * hashtags stay. The spaces and empty lines a removal leaves behind are
 * tidied; everything else stays as written.
 */
export function removeXMentions(text: string): string {
  if (!text.includes("@")) return text;
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    out.push(...paragraphWithoutMentions(paragraph));
    paragraph = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      out.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
