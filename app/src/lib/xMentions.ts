import { hashtagsIn } from "@/lib/hashtags";
import { textUnits } from "@/lib/truncate";
import { countsAsLink } from "@/lib/xWeightedLength";

// R60 platform-clients L2: as twitter-text, a mention starts after any character
// outside [A-Za-z0-9_!#$%&*@＠], so ".@kai", "—@ana" and "📸@kai" are mentions
// on X too, and "info@surf.com" is not. R61 platform-clients L1: as in
// twitter-text, the full-width "＠" is a mention sign too.
const MENTION = /(?<![A-Za-z0-9_!#$%&*@＠])[@＠]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
const MENTION_TOKEN = /^[@＠][A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*[,;]*$/;

/** Whether `text` has either mention sign, so a text without one is returned as is. */
function hasMentionSign(text: string): boolean {
  return text.includes("@") || text.includes("＠");
}
// Characters people put between footer tags: "#surf · @kai | @mia, @ana".
const SEPARATOR_TOKEN = /^[·•|,;/–—-]+$/;

// R68 pages-a-3 L1: /[,;]+$/ restarted at every comma of a run not at the very
// end, so 100,000 commas cost about 11 s. The look-behind lets a match start
// only where a run starts, so each run is read once: linear, same result.
// (A backward walk would end in a prefix slice, which codePointCut.guard lists.)
const TRAILING_COMMAS = /(?<![,;])[,;]+$/;

/** `text` without its trailing commas and semicolons. */
function withoutTrailingCommas(text: string): string {
  return text.replace(TRAILING_COMMAS, "");
}

function isHashtagToken(token: string): boolean {
  const bare = withoutTrailingCommas(token);
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
  return withoutTrailingCommas(kept.join(" "));
}

/**
 * The name a mention in running text leaves. R59 fix review L2: a dotted name
 * that X would count as a link ("vibesurfschool.za", "surf.co") keeps only the
 * part before its first dot, so the post never carries a link nobody wrote.
 * The test is the X count's own (countsAsLink), so the count and the cut
 * agree: a capitalised ending ("kai.Surf") is not a link (G1), and an ending
 * off X's list (".pro") is not cut. R60 platform-clients L3: any link inside
 * the name counts, as the X count weighs "kai.surf" in "kai.surf_co" as one.
 */
function bareName(name: string): string {
  if (!name.includes(".")) return name;
  const hasLink = textUnits(name).some((unit) => unit.link !== null && countsAsLink(unit.link, unit.text));
  return hasLink ? name.slice(0, name.indexOf(".")) : name;
}

/**
 * Where the links the X count finds lie in `line`, as [start, end) offsets.
 * R60 fix review M1: an "@" inside one ("youtube.com/@vibesurfschool") belongs
 * to the link, so it is never taken for a mention. The spans come from
 * textUnits, the X count's own split, so the count and the cut agree.
 */
function linkSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const unit of textUnits(line)) {
    if (unit.link !== null) spans.push([at, at + unit.text.length]);
    at += unit.text.length;
  }
  return spans;
}

function inRunningText(line: string): string {
  if (!hasMentionSign(line)) return line;
  // Every link has a dot, so a line without one needs no split.
  const spans = line.includes(".") ? linkSpans(line) : [];
  // Matches come in order, so one pass over the spans finds each one's link.
  let next = 0;
  return line.replace(MENTION, (whole: string, name: string, offset: number) => {
    while (next < spans.length && spans[next][1] <= offset) next += 1;
    const inLink = next < spans.length && spans[next][0] <= offset;
    return inLink ? whole : bareName(name);
  });
}

/** One paragraph's lines: a footer paragraph loses its mentions whole, any other only their "@". */
function paragraphWithoutMentions(lines: readonly string[]): string[] {
  const tokens = lines.map(tokensOf);
  const isFooter =
    tokens.some((line) => line.some((token) => MENTION_TOKEN.test(token))) && tokens.every(isTagLine);
  if (!isFooter) return lines.map(inRunningText);
  return lines.map((line, index) =>
    tokens[index].some((token) => MENTION_TOKEN.test(token))
      ? withoutMentions(tokens[index]) + (line.endsWith("\r") ? "\r" : "")
      : line,
  );
}

/** A line a mention was removed from: runs of spaces become one, and its ends are trimmed. */
function tidied(line: string): string {
  const end = line.endsWith("\r") ? "\r" : "";
  return line.slice(0, line.length - end.length).replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "") + end;
}

/** A run of blank lines, or a paragraph (consecutive lines with text). */
interface Block {
  blank: boolean;
  lines: string[];
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
 * A mention is an `@` (or the full-width `＠`) at the start of the text or after any character but a
 * letter, digit or one of `_!#$%&*@＠`, followed by a handle; dotted Instagram-style handles
 * (`@vibesurfschool.za`) count as one. An email address (`info@example.com`)
 * is not a mention and is kept.
 *
 * R59 new-customer-2 L2: deleting a handle from a sentence left "surf with ."
 * on a client's public post. In running text only the "@" goes ("with
 * vibesurfschool"), which X doesn't read as a mention. Whole handles go only
 * in the footer: a paragraph of its own (between blank lines, or at the start
 * or end) whose every line is mentions, hashtags and separators alone. Its
 * hashtags stay.
 *
 * R60 pages-a-4 L1: only the lines a mention was removed from are tidied
 * (spaces, and the line itself once it is empty); a footer paragraph that is
 * left empty goes with the blank lines before it (or after it, at the start).
 * Every other line, an indented price list or an email address included,
 * comes back exactly as written.
 */
export function removeXMentions(text: string): string {
  if (!hasMentionSign(text)) return text;
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const blank = line.trim() === "";
    const last = blocks.at(-1);
    if (last?.blank === blank) last.lines.push(line);
    else blocks.push({ blank, lines: [line] });
  }

  let changed = false;
  const out: Block[] = [];
  let dropNextBlank = false;
  for (const block of blocks) {
    if (block.blank) {
      if (!dropNextBlank) out.push(block);
      dropNextBlank = false;
      continue;
    }
    const after = paragraphWithoutMentions(block.lines);
    const lines: string[] = [];
    block.lines.forEach((line, index) => {
      if (after[index] === line) return lines.push(line);
      changed = true;
      const kept = tidied(after[index]);
      if (kept.trim() !== "") lines.push(kept);
    });
    if (lines.length > 0) out.push({ blank: false, lines });
    else {
      // R60 fix review L1: with nothing kept before it, the blank lines on
      // both sides go, so no stray newline starts the post.
      const keptBefore = out.some((kept) => !kept.blank);
      if (out.at(-1)?.blank) out.pop();
      if (!keptBefore) dropNextBlank = true;
    }
  }
  return changed ? out.flatMap((block) => block.lines).join("\n") : text;
}
