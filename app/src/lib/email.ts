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
