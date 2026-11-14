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
