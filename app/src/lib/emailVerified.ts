/**
 * Soft email verification gate for high-impact actions (publish).
 *
 * When RESEND_API_KEY is set the product can deliver verify emails, so we
 * require emailVerifiedAt before live multi-platform publish. When email is
 * not configured, verification is impossible — do not lock users out.
 */

export function isEmailVerificationEnforced(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function isEmailVerifiedForPublish(
  user: { emailVerifiedAt: Date | null },
): boolean {
  if (!isEmailVerificationEnforced()) {
    return true;
  }
  return user.emailVerifiedAt != null;
}

export const EMAIL_VERIFY_REQUIRED_MESSAGE =
  "Verify your email address before publishing. Check your inbox or resend from Settings.";
