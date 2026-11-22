import { truncateGraphemesWithinCodePoints } from "@/lib/truncate";

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function firstLetterOrDigit(text: string): string | null {
  return LETTER_OR_DIGIT.exec(text)?.[0] ?? null;
}

/**
 * One initial for a name shown in a circle (a Google reviewer): its first
 * letter or digit, composed first so "e" + accent reads "É", else "?". A
 * leading space, emoji or flag is skipped rather than cut in half (GG2 review).
 */
export function nameInitial(name: string): string {
  return firstLetterOrDigit(name.normalize("NFC"))?.toLocaleUpperCase() ?? "?";
}

/**
 * The account button's avatar: the first letters of the first and last word of
 * the person's name, else the first letter of their email, else "?". The
 * button used to show the email's first letter, which reads as a stray logo
 * ("I" for info@...). A word with no letter or digit (an emoji) is skipped.
 */
export function accountInitials(name: string | null | undefined, email: string): string {
  const letters = (name ?? "")
    .split(/\s+/)
    .map(firstLetterOrDigit)
    .filter((letter): letter is string => letter !== null);
  if (letters.length > 0) {
    const pair = letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0];
    return pair.toLocaleUpperCase();
  }
  return firstLetterOrDigit(email.trim())?.toLocaleUpperCase() ?? "?";
}

/** What the account button says: the person's name, else their email, else "Account". */
export function accountLabel(name: string | null | undefined, email: string): string {
  return name?.trim() || email.trim() || "Account";
}

const FIRST_NAME_MAX = 24;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `word` without the whole graphemes at each end that hold no letter or digit
 * ("(Klaus)" is "Klaus", "Ana☀️" is "Ana"). R67 new-customer L1: trimming code
 * points took a name's last combining mark ("प्रिया" lost its vowel sign), and
 * one pass over the graphemes replaces R66's quadratic end-anchored pattern.
 */
function withoutEdgeSymbols(word: string): string {
  let start = -1;
  let end = 0;
  for (const { segment, index } of graphemes.segment(word)) {
    if (!LETTER_OR_DIGIT.test(segment)) continue;
    if (start < 0) start = index;
    end = index + segment.length;
  }
  return start < 0 ? "" : word.slice(start, end);
}

/**
 * The Dashboard greets by first name: the first word with a letter or digit,
 * without the punctuation around it ("(Klaus)" is "Klaus"), at most 24
 * characters; null without one, so the greeting falls back to plain words.
 */
export function firstName(name: string | null | undefined): string | null {
  for (const word of (name ?? "").split(/\s+/)) {
    const trimmed = withoutEdgeSymbols(word);
    // R66: at most 24 code points in whole graphemes, so an emoji at the limit
    // is kept or dropped whole and a letter with many marks can't pass the bound.
    // When nothing whole fits, the next word is tried.
    const cut = trimmed ? truncateGraphemesWithinCodePoints(trimmed, FIRST_NAME_MAX) : "";
    if (cut) return cut;
  }
  return null;
}

/**
 * The account button's second line: the active workspace's name, only when the
 * person belongs to several (one per client), where posting in the wrong one is
 * the mistake to prevent. With one workspace the line would only repeat itself.
 */
export function accountWorkspaceLine(workspaces: Array<{ name: string; isActive: boolean }> | null): string | null {
  if (!workspaces || workspaces.length < 2) return null;
  return workspaces.find((workspace) => workspace.isActive)?.name ?? null;
}
