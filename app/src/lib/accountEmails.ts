import { Resend } from "resend";

/**
 * Account lifecycle (scale-readiness spec §A) — password-reset and
 * email-verification emails.
 *
 * Two pure builders (`buildPasswordResetEmail` / `buildVerifyEmail`) decide
 * WHAT to send, and `deliverAccountEmail` (impure) decides whether it CAN be
 * sent and does so fail-safely. The raw token appears exactly once per body,
 * inside a URL FRAGMENT (`#<token>`, never `?token=`) so it is never sent to a
 * server, logged in access logs, or leaked via the Referer header (SEC-1).
 *
 * `deliverAccountEmail` mirrors `server/notifications/email.ts` deliberately
 * (env-gating, `NOTIFICATIONS_FROM` fallback, swallow-and-log) rather than
 * sharing an abstraction, but returns a boolean so auth routes can present a
 * uniform response without branching on whether email is actually configured.
 */

const DEFAULT_FROM = "Vibe Socials <onboarding@resend.dev>";

export interface AccountEmail {
  subject: string;
  html: string;
  text: string;
}

export interface BuildAccountEmailOptions {
  /** Recipient address (used by the caller for delivery; not rendered). */
  to: string;
  /** The RAW token — embedded once, in the link fragment. */
  rawToken: string;
  /** App origin, e.g. `https://app.vibesocials.com` (NEXTAUTH_URL). */
  baseUrl: string;
}

interface AccountEmailContent {
  heading: string;
  intro: string;
  actionLabel: string;
  /** Path + fragment appended to baseUrl, e.g. `/reset-password`. */
  path: string;
  expiryNote: string;
}

/**
 * Shared renderer for the two account emails. The ONLY dynamic value in the
 * body is `link` (baseUrl origin + static path + base64url token), none of
 * whose parts contain HTML-special or quote characters, so no escaping is
 * needed and the html/text links stay byte-identical. The raw token is placed
 * exactly once — in the anchor `href` (html) and as the plain URL (text); the
 * visible anchor text is a label, never the URL, so the token never repeats.
 */
function renderAccountEmail(rawToken: string, baseUrl: string, content: AccountEmailContent): {
  html: string;
  text: string;
} {
  // Trim a trailing slash so a baseUrl like "https://host/" can't yield
  // "https://host//reset-password" (mirrors postOutcomeEmail's defensive trim).
  const link = `${baseUrl.replace(/\/+$/, "")}${content.path}#${rawToken}`;

  const html = [
    "<div>",
    `<h1>${content.heading}</h1>`,
    `<p>${content.intro}</p>`,
    `<p><a href="${link}">${content.actionLabel}</a></p>`,
    `<p style="color:#888888;font-size:12px;">${content.expiryNote}</p>`,
    "</div>",
  ].join("");

  const text = [
    content.heading,
    "",
    content.intro,
    "",
    link,
    "",
    content.expiryNote,
    "",
    "— Vibe Socials",
  ].join("\n");

  return { html, text };
}

/** Password-reset email. Subject/copy are sentence case (UI copy convention). */
export function buildPasswordResetEmail(opts: BuildAccountEmailOptions): AccountEmail {
  const subject = "Reset your Vibe Socials password";
  const { html, text } = renderAccountEmail(opts.rawToken, opts.baseUrl, {
    heading: "Reset your password",
    intro:
      "We received a request to reset the password for your Vibe Socials account. Use the link below to choose a new password.",
    actionLabel: "Reset your password",
    path: "/reset-password",
    expiryNote:
      "This link expires in 60 minutes. If you didn't request a password reset, you can safely ignore this email — your password won't change.",
  });
  return { subject, html, text };
}

/** Email-verification email. Subject/copy are sentence case. */
export function buildVerifyEmail(opts: BuildAccountEmailOptions): AccountEmail {
  const subject = "Verify your email address";
  const { html, text } = renderAccountEmail(opts.rawToken, opts.baseUrl, {
    heading: "Verify your email address",
    intro: "Confirm this email address to finish setting up your Vibe Socials account.",
    actionLabel: "Verify your email address",
    path: "/verify-email",
    expiryNote:
      "This link expires in 7 days. If you didn't create a Vibe Socials account, you can safely ignore this email.",
  });
  return { subject, html, text };
}

/**
 * Fail-safe account-email transport over Resend. Fully env-gated: with no
 * `RESEND_API_KEY` set (the default today) this is a complete no-op that
 * constructs no client and makes no network call, returning `false`. Every
 * failure mode (missing key, Resend construction/send error) is caught and
 * logged — it NEVER throws into the caller. Returns `true` only when the send
 * was actually dispatched, so callers can log/observe delivery without ever
 * branching their user-facing response on it (SEC-1: no existence oracle).
 */
export async function deliverAccountEmail(to: string, email: AccountEmail): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      "[Account] RESEND_API_KEY not set — account emails are disabled; skipping send.",
    );
    return false;
  }

  const from = process.env.NOTIFICATIONS_FROM || DEFAULT_FROM;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return true;
  } catch (error) {
    // Best-effort: swallow + log. Never throw — an auth route must complete
    // (and return its uniform response) regardless of email delivery.
    console.error("[Account] Failed to send account email", {
      to,
      subject: email.subject,
      error,
    });
    return false;
  }
}
