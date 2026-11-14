const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function firstLetterOrDigit(text: string): string | null {
  return LETTER_OR_DIGIT.exec(text)?.[0] ?? null;
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

/**
 * The Dashboard greets by first name: the first word with a letter or digit,
 * without the punctuation around it ("(Klaus)" is "Klaus"), at most 24
 * characters; null without one, so the greeting falls back to plain words.
 */
export function firstName(name: string | null | undefined): string | null {
  for (const word of (name ?? "").split(/\s+/)) {
    const trimmed = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (trimmed) return Array.from(trimmed).slice(0, FIRST_NAME_MAX).join("");
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
