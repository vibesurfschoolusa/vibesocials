import { Resend } from "resend";

/**
 * Roadmap Phase 6 — thin, fail-safe transport over Resend.
 *
 * Fully env-gated: with no `RESEND_API_KEY` set (the default today), `sendEmail`
 * is a complete no-op — it returns without constructing a client or making any
 * network call. This is the hard safety invariant for the whole notifications
 * feature: callers (see `server/notifications/postOutcomeEmail.ts`) must be able
 * to fire-and-forget this without it ever throwing, delaying, or otherwise
 * affecting their own flow. Every failure mode (missing key, Resend API error,
 * network error) is caught here and only logged.
 */

const DEFAULT_FROM = "Vibe Socials <onboarding@resend.dev>";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      "[Notifications] RESEND_API_KEY not set — email notifications are disabled; skipping send.",
    );
    return;
  }

  const from = process.env.NOTIFICATIONS_FROM || DEFAULT_FROM;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({ from, to, subject, html });
  } catch (error) {
    // Best-effort: swallow + log. Never throw — the caller (a post-outcome
    // notification) must complete regardless of whether the email actually
    // went out.
    console.error("[Notifications] Failed to send email", { to, subject, error });
  }
}
