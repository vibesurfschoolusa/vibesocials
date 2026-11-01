/**
 * Copy for the login page's `?error=<code>` banner. NextAuth sends OAuth
 * failures here (pages.signIn for transient errors, pages.error for an
 * AccessDenied refusal), and the Google signIn callback (lib/auth.ts)
 * redirects here with GOOGLE_PASSWORD_ACCOUNT_ERROR when it refuses to link
 * Google into an existing password account. The code itself is never shown.
 *
 * The password-account message names the cause, but only to someone who just
 * proved to Google that they own that mailbox, so it is not an existence
 * oracle for anyone else. Every other refusal (e.g. an unverified Google
 * email) keeps the generic AccessDenied copy.
 */
export const GOOGLE_PASSWORD_ACCOUNT_ERROR = "GooglePasswordAccount";

export function loginOAuthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === GOOGLE_PASSWORD_ACCOUNT_ERROR) {
    return "This email already has a password. Sign in with your password instead.";
  }
  if (code === "AccessDenied") {
    return "We couldn't sign you in with that Google account — use your email and password below instead.";
  }
  return "Sign-in didn't complete. Please try again.";
}
