import { isTerminalRefreshFailure } from "./platforms/connectionHealth";

/**
 * What kind of failure a Google call ended in (JJ3 lead review). It is the one
 * rule every Google Business Profile surface uses: the Reviews list, reply,
 * locations and link routes, and the Settings location picker. Each surface
 * words the kind itself, for an owner or a member.
 *
 * Each kind's next step names a control the person can see (JJ3 lead review):
 * Settings' Google Business Profile card shows Reconnect only for a flagged row,
 * and Connected, Switch account and Disconnect otherwise (connection-actions.tsx).
 *
 * - reconnect: the row is flagged (or gone), so the card shows Reconnect. A row
 *   already flagged or gone; no refresh token; a refresh failure that flags the
 *   row (the flag rule itself, isTerminalRefreshFailure).
 * - signInAgain: Google refused the token but nothing is flagged, so the card
 *   still shows Switch account. An API 401 (after any refresh); a 403
 *   ACCESS_TOKEN_SCOPE_INSUFFICIENT (signing in again grants the scope).
 * - access: a 403 with a permission reason or none. The connected account
 *   does not manage what was asked for; the same account again does not help.
 *   Never flagged.
 * - notFound: a 404 on the chosen location's own calls (its reviews, its review
 *   link): the location was removed from Google Business Profile. A 404 on any
 *   other call (a review being replied to, say) is "other".
 * - tryLater: Google or our own setup, not the person: a 403 SERVICE_DISABLED,
 *   accessNotConfigured or quota reason, a 429, a 5xx, no answer, our own
 *   timeout, invalid_client, missing OAuth credentials, another refresh holding
 *   the lock.
 * - other: anything else (another 404, a body we could not read, a bug).
 *
 * `googleReasons` on the error are googleErrorReasons' normalized form
 * (platforms/rateLimited.ts), set where the response is read (googleReviews.ts,
 * gbpLocations.ts).
 */
export type GoogleFailureKind = "reconnect" | "signInAgain" | "access" | "notFound" | "tryLater" | "other";

/** The calls on the chosen location itself, whose 404 means the location is gone (googleReviews.ts). */
const LOCATION_CALL_CODES: ReadonlySet<string> = new Set(["GBP_REVIEWS_FETCH_FAILED", "GBP_REVIEW_LINK_FETCH_FAILED"]);

const RECONNECT_CODES: ReadonlySet<string> = new Set(["RECONNECT_REQUIRED", "CONNECTION_GONE", "GOOGLE_NO_REFRESH_TOKEN"]);
/**
 * "FETCH_TIMEOUT" is fetchWithTimeout's FETCH_TIMEOUT_CODE, written out so this
 * module does not load fetchWithTimeout (tests that mock it whole import
 * googleReviews); googleFailure.test.ts keeps the two equal.
 */
const TRY_LATER_CODES: ReadonlySet<string> = new Set([
  "GOOGLE_MISSING_OAUTH_CREDENTIALS",
  "CONNECTION_REFRESH_BUSY",
  "FETCH_TIMEOUT",
]);
const REFRESH_FAILED_CODE = "GOOGLE_TOKEN_REFRESH_FAILED";

/** 403 reasons for a token without the scope the call needs. */
const SCOPE_REASONS: ReadonlySet<string> = new Set(["accesstokenscopeinsufficient"]);

/** 403 reasons that are our side's API setup or quota. */
const SERVICE_REASONS: ReadonlySet<string> = new Set([
  "servicedisabled",
  "accessnotconfigured",
  "quotaexceeded",
  "dailylimitexceeded",
  "ratelimitexceeded",
  "userratelimitexceeded",
]);

interface FailureFields {
  status?: unknown;
  code?: unknown;
  oauthError?: unknown;
  googleReasons?: unknown;
}

function reasonsOf(error: FailureFields): string[] {
  const reasons = error.googleReasons;
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [];
}

const transient = (status: number) => status === 429 || status >= 500;

/** The kind, without logging (a test seam and the rule itself). */
export function googleFailureKind(error: unknown): GoogleFailureKind {
  if (error instanceof TypeError && error.message === "fetch failed") return "tryLater"; // undici: no answer
  const fields = (error !== null && typeof error === "object" ? error : {}) as FailureFields;
  const status = typeof fields.status === "number" ? fields.status : null;
  const code = typeof fields.code === "string" ? fields.code : null;

  if (code === REFRESH_FAILED_CODE) {
    const oauth = typeof fields.oauthError === "string" ? fields.oauthError : undefined;
    if (oauth === "invalid_client") return "tryLater";
    // No status passed on: only the OAuth code can say the grant is dead.
    if (isTerminalRefreshFailure(status ?? 0, oauth)) return "reconnect";
    return status !== null && transient(status) ? "tryLater" : "other";
  }
  if (code && RECONNECT_CODES.has(code)) return "reconnect";
  if (code && TRY_LATER_CODES.has(code)) return "tryLater";

  if (status === 401) return "signInAgain";
  if (status === 404) return code && LOCATION_CALL_CODES.has(code) ? "notFound" : "other";
  if (status === 403) {
    const reasons = reasonsOf(fields);
    if (reasons.some((reason) => SCOPE_REASONS.has(reason))) return "signInAgain";
    if (reasons.some((reason) => SERVICE_REASONS.has(reason))) return "tryLater";
    return "access";
  }
  if (status !== null && transient(status)) return "tryLater";
  return "other";
}

/**
 * The kind, logged once: where, the kind, and the status, code, OAuth code and
 * reasons when there are any. Never a message, body or token.
 */
export function classifyGoogleFailure(error: unknown, where: string): GoogleFailureKind {
  const kind = googleFailureKind(error);
  const fields = (error !== null && typeof error === "object" ? error : {}) as FailureFields;
  const reasons = reasonsOf(fields);
  console.warn("[Google] request failed", {
    where,
    kind,
    ...(typeof fields.status === "number" ? { status: fields.status } : {}),
    ...(typeof fields.code === "string" ? { code: fields.code } : {}),
    ...(typeof fields.oauthError === "string" ? { oauthError: fields.oauthError } : {}),
    ...(reasons.length > 0 ? { reasons } : {}),
    // Unexpected: the error's name helps find it (never its message).
    ...(kind === "other" && error instanceof Error ? { name: error.name } : {}),
  });
  return kind;
}
