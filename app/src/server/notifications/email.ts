import { RetryAfterError } from "inngest";
import { Resend } from "resend";

import { logger } from "@/lib/logger";

/**
 * Roadmap Phase 6 — thin, fail-safe transport over Resend.
 *
 * Fully env-gated: with no `RESEND_API_KEY` set (the default today), `sendEmail`
 * is a complete no-op — it returns without constructing a client or making any
 * network call. This is the hard safety invariant for the whole notifications
 * feature: callers (see `server/notifications/postOutcomeEmail.ts`) must be able
 * to fire-and-forget this without it ever throwing, delaying, or otherwise
 * affecting their own flow. Every failure mode (missing key, Resend API error
 * — thrown or returned as `{ error }` — network error) is caught here and only
 * logged.
 *
 * 2026-11-01 scale audit (jobs, notifications): the one exception is opt-in. A
 * caller that can retry (the `deliver-notification` / `notify-owners` Inngest
 * steps) passes `throwOnRetryable: true`, and a Resend 429, a 409
 * `concurrent_idempotent_requests`, a 5xx or a network error then throws so the
 * step is retried instead of the email being dropped. Every other caller (auth,
 * approval and invite mail) calls without options and keeps the never-throws
 * contract.
 */

const DEFAULT_FROM = "Vibe Socials <onboarding@resend.dev>";

/**
 * How long Inngest waits before retrying a send Resend rate-limited. Resend
 * allows 10 requests/s per team and answers 429 (with a `retry-after` header)
 * beyond that - https://resend.com/docs/api-reference/rate-limit. The
 * notification sender is throttled to 8 run starts/s, so a 429 is a brief
 * overlap with the auth/approval/reconnect mail sent outside Inngest; a short
 * fixed wait clears it.
 */
const RATE_LIMIT_RETRY_AFTER_MS = 2_000;

/**
 * Resend's idempotency-key conflicts (https://resend.com/docs/dashboard/emails/idempotency-keys):
 * the same key with a different payload is 409 `invalid_idempotent_request`; the
 * same key while the first request is still running is 409
 * `concurrent_idempotent_requests`.
 */
const INVALID_IDEMPOTENT_REQUEST = "invalid_idempotent_request";
const CONCURRENT_IDEMPOTENT_REQUESTS = "concurrent_idempotent_requests";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailOptions {
  /**
   * Sent as Resend's `Idempotency-Key` (kept 24 h): a repeat of the same key is a
   * no-op, so a retry after a lost ack cannot send the email twice.
   */
  idempotencyKey?: string;
  /**
   * Throw (instead of log and swallow) a failure that a retry can fix: a
   * `RetryAfterError` for a 429 / in-flight 409, an `EmailRetryableError` for a
   * 5xx or a network error. Set ONLY by callers inside a retried Inngest step.
   */
  throwOnRetryable?: boolean;
}

/** A transient delivery failure (5xx or network). The message never carries the recipient. */
export class EmailRetryableError extends Error {
  code = "EMAIL_RETRYABLE";

  constructor(message: string) {
    super(message);
    this.name = "EmailRetryableError";
  }
}

/** True for the two errors `sendEmail` throws under `throwOnRetryable`. */
export function isRetryableEmailError(error: unknown): boolean {
  return error instanceof EmailRetryableError || error instanceof RetryAfterError;
}

type ResendFailure = { name?: string; statusCode?: number | null };

/**
 * What a Resend rejection means for the caller:
 *  - "already_sent": 409 `invalid_idempotent_request` - a send with this key went out;
 *  - "rate_limited": 429, or 409 `concurrent_idempotent_requests` (the first send
 *    is still in flight) - retry shortly;
 *  - "transient": 5xx, or no status at all (the SDK reports an unresolved request
 *    that way) - retry;
 *  - "rejected": any other 4xx - retrying cannot help.
 */
function classifyResendFailure({
  name,
  statusCode,
}: ResendFailure): "already_sent" | "rate_limited" | "transient" | "rejected" {
  if (statusCode === 409 && name === INVALID_IDEMPOTENT_REQUEST) return "already_sent";
  if (statusCode === 429 || (statusCode === 409 && name === CONCURRENT_IDEMPOTENT_REQUESTS)) {
    return "rate_limited";
  }
  if (typeof statusCode !== "number" || statusCode >= 500) return "transient";
  return "rejected";
}

export async function sendEmail(
  { to, subject, html }: SendEmailParams,
  { idempotencyKey, throwOnRetryable = false }: SendEmailOptions = {},
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      "[Notifications] RESEND_API_KEY not set — email notifications are disabled; skipping send.",
    );
    return;
  }

  const from = process.env.NOTIFICATIONS_FROM || DEFAULT_FROM;

  let resend: Resend;
  try {
    resend = new Resend(apiKey);
  } catch (error) {
    // A bad key is configuration, not a transient failure: never retried.
    console.error("[Notifications] Failed to send email", { to, subject, error });
    return;
  }

  const payload = { from, to, subject, html };
  let response: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    response = idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey })
      : await resend.emails.send(payload);
  } catch (error) {
    if (throwOnRetryable) {
      logger.warn("[Notifications] Resend request threw; the step will retry", { subject });
      throw new EmailRetryableError("Resend request failed before a response (network error)");
    }
    // Best-effort: swallow + log. Never throw — the caller (a post-outcome
    // notification) must complete regardless of whether the email actually
    // went out.
    console.error("[Notifications] Failed to send email", { to, subject, error });
    return;
  }

  // Resend 6.x reports an API rejection (bad key, unverified sender,
  // quota...) by RESOLVING { data: null, error } — it does not throw.
  const { error } = response;
  if (!error) return;

  const failure = classifyResendFailure(error);

  if (failure === "already_sent") {
    // The key was already used for a send: the email went out on an earlier
    // attempt whose ack was lost. Treated as sent.
    logger.warn("[Notifications] Resend already accepted this idempotency key; treating as sent", {
      subject,
    });
    return;
  }

  if (throwOnRetryable && failure !== "rejected") {
    logger.warn("[Notifications] Resend send failed; the step will retry", {
      subject,
      error: { name: error.name, statusCode: error.statusCode },
    });
    const detail = `status ${error.statusCode ?? "none"}, ${error.name}`;
    if (failure === "rate_limited") {
      throw new RetryAfterError(`Resend rate limited the send (${detail})`, RATE_LIMIT_RETRY_AFTER_MS);
    }
    throw new EmailRetryableError(`Resend send failed (${detail})`);
  }

  logger.error("[Notifications] Resend rejected email", {
    subject,
    error: { name: error.name, message: error.message, statusCode: error.statusCode },
  });
}
