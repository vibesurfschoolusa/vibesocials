/**
 * App-wide email normalization.
 *
 * Emails are always stored and looked up as trim + lowercase so
 * `User@Example.com` and `user@example.com` cannot become two accounts, and
 * password-reset / login always hit the same row regardless of casing.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The longest address accepted (RFC 5321's 254-character path limit). */
export const EMAIL_MAX_LENGTH = 254;

/** One whitespace character; a single-character test, so it can't backtrack. */
const WHITESPACE = /\s/;

/**
 * True for a string shaped like an email address: no whitespace, something
 * before an "@", and after it a "." with something on each side. The same
 * addresses as the old `/^\S+@\S+\.\S+$/`, which backtracked: R45 review M1, a
 * 10,000-character "a.@a.@…" took 43 s, and register and forgot-password run
 * the check before any limit. So the length is capped first and the rest is
 * a few linear scans.
 */
export function isEmailShaped(value: unknown): value is string {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH || WHITESPACE.test(value)) return false;
  // The first "@" after the first character leaves the longest domain part,
  // so if any split of the old pattern matches, this one does.
  const at = value.indexOf("@", 1);
  if (at === -1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf(".", 1);
  return dot !== -1 && dot < domain.length - 1;
}
