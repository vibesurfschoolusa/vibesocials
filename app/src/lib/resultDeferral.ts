/**
 * 2026-11-01 scale audit (platform limits): a result whose platform answered with
 * a rate limit or quota refusal is not failed. It stays `pending` while the run
 * sleeps until `deferredUntil` and tries again (platformSteps.ts), and the
 * Activity card says so. Pure and client-safe: no server imports, so the card
 * can import it.
 */

/** Why a pending result is waiting. */
export type DeferralKind = "daily_limit" | "rate_limited";

/**
 * `PostJobResult.errorCode` of a result waiting out (or, after the last wait,
 * failed by) a daily limit or quota. A short-term rate limit uses RATE_LIMITED
 * (rateLimited.ts).
 */
export const DAILY_LIMIT_CODE = "DAILY_LIMIT";

/**
 * The wait's kind from the result's stored `errorCode` (which the API itself
 * never exposes). `DAILY_LIMIT` is a daily limit; anything else, including a
 * missing code, reads as a plain rate limit.
 */
export function deferralKindFromErrorCode(code: string | null): DeferralKind {
  return code === DAILY_LIMIT_CODE ? "daily_limit" : "rate_limited";
}

/**
 * The line shown under a pending result that is waiting out a platform limit.
 * `format` renders the instant in the viewer's locale (the card passes
 * `toLocaleString`), so the copy itself stays testable without a locale.
 */
export function describeDeferral(
  label: string,
  kind: DeferralKind,
  until: Date,
  format: (date: Date) => string,
): string {
  return kind === "daily_limit"
    ? `${label} daily limit reached — will publish after ${format(until)}`
    : `${label} rate limit reached — will retry after ${format(until)}`;
}
