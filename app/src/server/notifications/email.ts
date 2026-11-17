import { RetryAfterError } from "inngest";
import { Resend } from "resend";

import { logger } from "@/lib/logger";
import { htmlToPlainText } from "@/server/notifications/plainText";

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
 * R42 security L2: what each Resend 4xx error name means for a send, the one
 * table every caller's outcome comes from. Source: Resend's errors page,
 * https://resend.com/docs/api-reference/errors (read 2026-11-17). Names marked
 * "earlier page" were on that page before and may still be answered.
 *  - "not_configured": our request or our account set-up is wrong. It hits
 *    every send, and once fixed every send can go, so nobody is written off.
 *  - "quota_exceeded": the daily quota "reset[s] at midnight UTC", the monthly
 *    one needs a larger plan: no retry within an Inngest step can succeed.
 *  - "rate_limited": per-second limits and in-flight conflicts: retry shortly.
 *  - "already_sent": the same idempotency key with another payload
 *    (https://resend.com/docs/dashboard/emails/idempotency-keys): a send with
 *    that key went out.
 *  - "rejected": about this recipient or this message's content.
 * A 4xx name not listed here is "rejected", so one bad address is never tried
 * forever; any other 401 or 403 is a key or account problem ("not_configured").
 */
const RESEND_4XX_NAMES: Readonly<Record<string, "not_configured" | "quota_exceeded" | "rate_limited" | "already_sent" | "rejected">> = {
  // Our request: a malformed field (validation_error also covers an invalid
  // key, a sandbox-only sender and an unverified `from` domain), a missing or
  // bad parameter, a wrong endpoint or method.
  validation_error: "not_configured",
  missing_required_field: "not_configured",
  missing_required_parameter: "not_configured",
  invalid_parameter: "not_configured",
  invalid_idempotency_key: "not_configured",
  not_found: "not_configured",
  method_not_allowed: "not_configured",
  invalid_from_address: "not_configured", // earlier page: a malformed NOTIFICATIONS_FROM
  invalid_access: "not_configured", // earlier page
  invalid_region: "not_configured", // earlier page
  // Our key or account.
  missing_api_key: "not_configured",
  invalid_api_key: "not_configured", // earlier page
  restricted_api_key: "not_configured",
  suspended_api_key: "not_configured",
  invalid_permission: "not_configured",
  // Quota and rate.
  daily_quota_exceeded: "quota_exceeded",
  monthly_quota_exceeded: "quota_exceeded",
  rate_limit_exceeded: "rate_limited",
  concurrent_idempotent_requests: "rate_limited",
  resource_locked: "rate_limited",
  invalid_idempotent_request: "already_sent",
  // This message's content.
  invalid_attachment: "rejected",
};

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** The plain-text part; made from `html` when omitted, so no email goes out HTML-only. */
  text?: string;
}

export interface SendEmailOptions {
  /**
   * A fixed label for this kind of email ("member-joined"), the only thing the
   * log lines name the send by (R21 client-journey L2). Without it the
   * idempotency key's first segment is used; sendEmailLabels.test.ts checks
   * every caller gives one or the other.
   */
  label?: string;
  /**
   * Sent as Resend's `Idempotency-Key` (kept 24 h): a repeat of the same key is a
   * no-op, so a retry after a lost ack cannot send the email twice.
   */
  idempotencyKey?: string;
  /**
   * Throw (instead of log and swallow) a failure that a retry can fix: a
   * `RetryAfterError` for a 429 / in-flight 409, an `EmailRetryableError` for a
   * 5xx or a network error. A daily or monthly quota 429 is not one of them: it
   * is logged and dropped. Set ONLY by callers inside a retried Inngest step.
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

/**
 * R40 lead review: Resend's 429 rate limit refused the email before sending, so
 * this one RetryAfterError is marked `emailNotSent` (sendOncePer then lets its
 * window go whatever the keys). Still a RetryAfterError, with its name and
 * delay, so every retry reads it as before. A 409 in flight, a 5xx and a
 * network error stay unmarked: their email may have gone.
 */
export class EmailRateLimitedError extends RetryAfterError {
  readonly emailNotSent = true as const;
}

/** True for the two errors `sendEmail` throws under `throwOnRetryable`. */
export function isRetryableEmailError(error: unknown): boolean {
  return error instanceof EmailRetryableError || error instanceof RetryAfterError;
}

type ResendFailure = { name?: string; statusCode?: number | null };

type ResendFailureKind = "already_sent" | "quota_exceeded" | "rate_limited" | "transient" | "not_configured" | "rejected";

/**
 * What a Resend rejection means for the caller: a 5xx, or no status at all (the
 * SDK reports an unresolved request that way), is "transient" (retry); a 4xx
 * reads RESEND_4XX_NAMES, then any other 429 is a rate limit, any other 401 or
 * 403 a key problem, and the rest "rejected".
 */
function classifyResendFailure({ name, statusCode }: ResendFailure): ResendFailureKind {
  if (typeof statusCode !== "number" || statusCode >= 500) return "transient";
  const known = name !== undefined && Object.hasOwn(RESEND_4XX_NAMES, name) ? RESEND_4XX_NAMES[name] : undefined;
  if (known) return known;
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 401 || statusCode === 403) return "not_configured";
  return "rejected";
}

/**
 * `text` with every occurrence of the recipient address replaced (case
 * insensitive). Used for upstream error messages before they are logged: an email
 * address is personal data and must not reach the logs (final review F9).
 */
function withoutRecipient(text: string, to: string): string {
  if (!to) return text;
  const needle = to.toLowerCase();
  const haystack = text.toLowerCase();
  let result = "";
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    result += text.slice(from, at) + "[recipient]";
    from = at + needle.length;
  }
  return result + text.slice(from);
}

/** An error reduced to its name and message, minus the recipient, for logging. */
function loggableError(error: unknown, to: string): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: withoutRecipient(error.message, to) }
    : { name: typeof error, message: withoutRecipient(String(error), to) };
}

/**
 * R21 client-journey L2: what the log lines name the send by. Never the subject:
 * the client upload email's carries the name a client typed, and logger.error
 * reaches Sentry. The caller's `label`, else the first segment of its
 * idempotency key (every keyed caller starts it with a fixed label:
 * "client-upload/..."); anything that is not a plain label is "unlabelled".
 */
function emailKind(label: string | undefined, idempotencyKey: string | undefined): string {
  const plain = (value: string | undefined) => (value && /^[a-z][a-z0-9-]{0,40}$/.test(value) ? value : null);
  return plain(label) ?? plain(idempotencyKey?.split("/")[0]) ?? "unlabelled";
}

/**
 * R41 lead review: whether the email went and, when it did not, why.
 * "try_later": a later send can go (a daily or monthly quota 429, or, without
 * throwOnRetryable, a swallowed 5xx, rate limit or network error).
 * "not_configured": no key, a bad key (a constructor error, a 401 or 403) or
 * another error about our request or set-up (RESEND_4XX_NAMES): no send goes
 * until the set-up is fixed, then every one can.
 * "refused": Resend refused this recipient or this message for good (a 4xx
 * about the content, or a name the table doesn't know).
 */
export type SendEmailOutcome = { sent: true } | { sent: false; reason: "try_later" | "not_configured" | "refused" };

const SENT: SendEmailOutcome = { sent: true };
const TRY_LATER: SendEmailOutcome = { sent: false, reason: "try_later" };
const NOT_CONFIGURED: SendEmailOutcome = { sent: false, reason: "not_configured" };
const REFUSED: SendEmailOutcome = { sent: false, reason: "refused" };

/**
 * Resolves true when Resend accepted the email (or already had it under this
 * idempotency key), false when it did not go out. R23-client-journey L4: a
 * caller that tells someone "they were emailed" reads it; others ignore it.
 * A caller that must tell "try later" from "refused for good" uses
 * sendEmailOutcome.
 */
export async function sendEmail(params: SendEmailParams, options: SendEmailOptions = {}): Promise<boolean> {
  return (await sendEmailOutcome(params, options)).sent;
}

/** sendEmail with the reason a send didn't go; throws exactly when sendEmail does. */
export async function sendEmailOutcome(
  { to, subject, html, text }: SendEmailParams,
  { label, idempotencyKey, throwOnRetryable = false }: SendEmailOptions = {},
): Promise<SendEmailOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  const kind = emailKind(label, idempotencyKey);

  if (!apiKey) {
    console.log(
      "[Notifications] RESEND_API_KEY not set — email notifications are disabled; skipping send.",
    );
    return NOT_CONFIGURED;
  }

  const from = process.env.NOTIFICATIONS_FROM || DEFAULT_FROM;

  let resend: Resend;
  try {
    resend = new Resend(apiKey);
  } catch (error) {
    // A bad key is configuration, not a transient failure: never retried.
    // No log line here carries the recipient address (final review F9).
    console.error("[Notifications] Failed to send email", { kind, error: loggableError(error, to) });
    return NOT_CONFIGURED;
  }

  const payload = { from, to, subject, html, text: text ?? htmlToPlainText(html) };
  let response: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    response = idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey })
      : await resend.emails.send(payload);
  } catch (error) {
    if (throwOnRetryable) {
      logger.warn("[Notifications] Resend request threw; the step will retry", { kind });
      throw new EmailRetryableError("Resend request failed before a response (network error)");
    }
    // Best-effort: swallow + log. Never throw — the caller (a post-outcome
    // notification) must complete regardless of whether the email actually
    // went out. The recipient address is never logged (final review F9).
    console.error("[Notifications] Failed to send email", { kind, error: loggableError(error, to) });
    return TRY_LATER;
  }

  // Resend 6.x reports an API rejection (bad key, unverified sender,
  // quota...) by RESOLVING { data: null, error } — it does not throw.
  const { error } = response;
  if (!error) return SENT;

  const failure = classifyResendFailure(error);

  if (failure === "already_sent") {
    // The key was already used for a send: the email went out on an earlier
    // attempt whose ack was lost. Treated as sent.
    logger.warn("[Notifications] Resend already accepted this idempotency key; treating as sent", {
      kind,
    });
    return SENT;
  }

  // A quota 429 is dropped like any other rejection: it falls through to the
  // error log below (name and status, no recipient) even under `throwOnRetryable`.
  // 2026-11-02 scale audit (jobs, notifications): it used to be retried as a rate
  // limit, burning the step's retries against a quota that cannot reset in time.
  if (throwOnRetryable && (failure === "rate_limited" || failure === "transient")) {
    logger.warn("[Notifications] Resend send failed; the step will retry", {
      kind,
      error: { name: error.name, statusCode: error.statusCode },
    });
    const detail = `status ${error.statusCode ?? "none"}, ${error.name}`;
    if (failure === "rate_limited") {
      if (error.statusCode === 429) {
        throw new EmailRateLimitedError(`Resend rate limited the send (${detail})`, RATE_LIMIT_RETRY_AFTER_MS);
      }
      throw new RetryAfterError(`Resend rate limited the send (${detail})`, RATE_LIMIT_RETRY_AFTER_MS);
    }
    throw new EmailRetryableError(`Resend send failed (${detail})`);
  }

  logger.error("[Notifications] Resend rejected email", {
    kind,
    // Resend's message is its own text, but strip the recipient in case it echoes it.
    // 2026-11-02 phase 2 final review: a JSON error body can carry no string `message`
    // at all, so coerce it; the logging path must never throw out of `sendEmail`.
    error: {
      name: error.name,
      message: withoutRecipient(String(error.message ?? ""), to),
      statusCode: error.statusCode,
    },
  });
  return resendErrorOutcome(error);
}

/**
 * What sendEmailOutcome resolves to, without throwOnRetryable, for Resend's
 * answer `error`: the one mapping from RESEND_4XX_NAMES to an outcome.
 */
export function resendErrorOutcome(error: ResendFailure): SendEmailOutcome {
  switch (classifyResendFailure(error)) {
    case "already_sent":
      return SENT;
    case "not_configured":
      return NOT_CONFIGURED;
    case "rejected":
      return REFUSED;
    default:
      return TRY_LATER;
  }
}
