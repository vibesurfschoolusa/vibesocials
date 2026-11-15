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

/**
 * R6-security M1: Google sign-in refused to create an account on an address
 * an email change replaced, while that change's undo may still put it back
 * (lib/googleSso.ts `address_held`). Shown only to someone who just proved to
 * Google that they own the mailbox, which is where the change notice and its
 * undo link went, so it tells them nothing they weren't sent. No date: the
 * code travels alone in the URL.
 */
export const GOOGLE_ADDRESS_HELD_ERROR = "GoogleAddressHeld";

export function loginOAuthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === GOOGLE_PASSWORD_ACCOUNT_ERROR) {
    return "This email already has a password. Sign in with your password instead.";
  }
  if (code === GOOGLE_ADDRESS_HELD_ERROR) {
    return "This address was recently moved off a Vibe Socials account, so it can't be used for a new account until 72 hours after the move. Sign in with the account's current email. If you didn't make that change, use the undo link we emailed to this address.";
  }
  if (code === "AccessDenied") {
    return "We couldn't sign you in with that Google account — use your email and password below instead.";
  }
  return "Sign-in didn't complete. Please try again.";
}
