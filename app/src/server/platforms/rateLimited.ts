import type { Platform } from "@prisma/client";

import { platformLabel } from "@/lib/platforms";

// 2026-11-01 scale audit (platform limits): today a platform 429 or quota
// response just fails the post. This module classifies those responses into a
// typed RateLimitedError so a job can wait out the limit (retryAt) instead of
// failing. Every vendor value below is named, with its source; a value we could
// not confirm says "unconfirmed" and fails safe (null retryAt -> the run's
// backoff schedule applies).

/** `error.code` of every RateLimitedError. Never retried in-step (transientRetry.ts). */
export const RATE_LIMITED_CODE = "RATE_LIMITED";

/**
 * Slack added after a Pacific-midnight quota reset before we try again, so a
 * small clock difference between us and Google cannot send the retry in a hair
 * early and burn an attempt on a still-exhausted quota.
 */
export const PACIFIC_RESET_GRACE_MS = 300_000;

/**
 * YouTube quotas reset at midnight Pacific Time ("Daily quotas reset at
 * midnight Pacific Time", page updated 2026-10-15).
 * Source: https://developers.google.com/youtube/v3/determine_quota_cost
 */
const YOUTUBE_QUOTA_TIME_ZONE = "America/Los_Angeles";

/**
 * YouTube error `reason`s that mean the project's quota is spent until the
 * Pacific-midnight reset (HTTP 403). Source:
 * https://developers.google.com/youtube/v3/docs/core_errors,
 * https://developers.google.com/youtube/v3/docs/errors
 */
const YOUTUBE_QUOTA_REASONS: ReadonlySet<string> = new Set(["quotaexceeded", "dailylimitexceeded"]);

/**
 * `uploadLimitExceeded` (HTTP 400): the channel hit its own upload cap,
 * "separate from your Google Cloud project's API quota". Source:
 * https://developers.google.com/youtube/v3/docs/errors. When it lifts is
 * unconfirmed (plan U3): we wait for the next Pacific midnight, and three
 * misses end as a failed post.
 */
const YOUTUBE_UPLOAD_LIMIT_REASON = "uploadlimitexceeded";

/**
 * Per-second/minute rate reasons (HTTP 403, or 429 for `rateLimitExceeded`).
 * Source: https://developers.google.com/youtube/v3/docs/core_errors
 */
const YOUTUBE_RATE_REASONS: ReadonlySet<string> = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
]);

/**
 * Meta (Graph API) throttle `error.code`s: 4 (app), 17 (user), 32 (Page),
 * 613 (custom), 80001 (Page token) and 80002 (Instagram).
 * Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */
const META_THROTTLE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80001, 80002]);

/**
 * Code 4 with this subcode means "suspected spam" and is NOT a rate limit.
 * Source: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
 */
const META_SPAM_SUBCODE = 2207051;

/**
 * Instagram code 9 / subcode 2207042 (HTTP 400): the publishing limit is
 * reached, "try again the following day". The limit is 100 API posts per 24 h
 * moving window. Source: same error-codes page as above, and
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
const INSTAGRAM_PUBLISH_LIMIT_CODE = 9;
const INSTAGRAM_PUBLISH_LIMIT_SUBCODE = 2207042;
/** The window is a 24 h moving one, so a full day is the safe wait. */
const INSTAGRAM_PUBLISH_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * `X-Business-Use-Case-Usage[...].estimated_time_to_regain_access` is in
 * **minutes**. Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */
const META_BUC_HEADER = "x-business-use-case-usage";
const MS_PER_MINUTE = 60_000;

/**
 * X answers an exhausted limit with HTTP 429 and `x-rate-limit-reset`, a Unix
 * timestamp in **seconds**. Source: https://docs.x.com/x-api/fundamentals/rate-limits
 */
const X_RESET_HEADER = "x-rate-limit-reset";

/**
 * TikTok's `rate_limit_exceeded` comes back as HTTP 429 with the body
 * `{ error: { code, message, log_id } }`. Source:
 * https://developers.tiktok.com/doc/tiktok-api-v2-error-handling
 */
const TIKTOK_RATE_LIMIT_CODE = "rate_limit_exceeded";

/*
 * LinkedIn (https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits)
 * and Google Business Profile (https://developers.google.com/my-business/content/limits)
 * both answer with HTTP 429. Whether they, Meta (without a BUC header) and
 * TikTok send `Retry-After` is unconfirmed (plan U5): without one retryAt is
 * null and the run's backoff schedule applies.
 */

export type RateLimitKind = "rate_limited" | "daily_limit" | "youtube_quota";

export type RateLimitedError = Error & {
  code: typeof RATE_LIMITED_CODE;
  platform: Platform;
  kind: RateLimitKind;
  /** Epoch ms at which to try again, or null when the platform gave no usable hint. */
  retryAt: number | null;
};

export function rateLimitedError(
  platform: Platform,
  kind: RateLimitKind,
  retryAt: number | null,
): RateLimitedError {
  // The message reaches PostJobResult.errorMessage and the UI: no upstream text.
  const error = new Error(`${platformLabel(platform)} is limiting requests right now.`);
  return Object.assign(error, { code: RATE_LIMITED_CODE, platform, kind, retryAt } as const);
}

export function isRateLimitedError(error: unknown): error is RateLimitedError {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { code?: unknown; platform?: unknown; kind?: unknown; retryAt?: unknown };
  return (
    e.code === RATE_LIMITED_CODE &&
    typeof e.platform === "string" &&
    typeof e.kind === "string" &&
    (e.retryAt === null || typeof e.retryAt === "number")
  );
}

/** `Retry-After`: delta-seconds or an HTTP-date. A value that is not in the future is null. */
function retryAfterAt(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  const at = /^\d+$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
  return Number.isFinite(at) && at > now ? at : null;
}

/** `x-rate-limit-reset`: epoch seconds. A value that is not in the future is null. */
function xResetAt(headers: Headers, now: number): number | null {
  const raw = headers.get(X_RESET_HEADER)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const at = Number(raw) * 1000;
  return Number.isFinite(at) && at > now ? at : null;
}

/**
 * When to retry, from the response headers: `x-rate-limit-reset` (epoch
 * seconds), then `Retry-After` (delta-seconds or an HTTP-date). A value that is
 * not in the future or cannot be parsed is ignored; no usable header gives null.
 */
export function retryAtFromHeaders(headers: Headers, now: number): number | null {
  return xResetAt(headers, now) ?? retryAfterAt(headers, now);
}

/**
 * When to retry a Meta throttle: the largest `estimated_time_to_regain_access`
 * (minutes) over every entry of `X-Business-Use-Case-Usage`. A value of 0 or
 * less, a missing field or a malformed header gives null.
 */
export function metaRetryAt(headers: Headers, now: number): number | null {
  const raw = headers.get(META_BUC_HEADER);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let maxMinutes = 0;
  for (const entries of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const minutes = (entry as { estimated_time_to_regain_access?: unknown } | null)
        ?.estimated_time_to_regain_access;
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > maxMinutes) {
        maxMinutes = minutes;
      }
    }
  }
  return maxMinutes > 0 ? now + maxMinutes * MS_PER_MINUTE : null;
}

const pacificFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: YOUTUBE_QUOTA_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The Pacific wall-clock reading of an instant. */
function pacificWallClock(epochMs: number) {
  const parts: Record<string, number> = {};
  for (const part of pacificFormat.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Pacific's offset from UTC (negative) at an instant, in ms, from the zone database. */
function pacificOffsetMs(epochMs: number): number {
  const w = pacificWallClock(epochMs);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The calendar day in Pacific time, `YYYY-MM-DD`: the key of YouTube's daily quota. */
export function pacificDayKey(now: Date): string {
  const w = pacificWallClock(now.getTime());
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${two(w.month)}-${two(w.day)}`;
}

/**
 * The next 00:00 Pacific strictly after `now`, when YouTube's quota resets.
 *
 * Built from the Pacific calendar date and the zone database's offset, never a
 * fixed -7 / -8 h: on the DST change days the day is 25 or 23 h long. The
 * changes happen at 02:00, so 00:00 itself always exists and is unambiguous;
 * the offset is looked up twice because the first guess uses the offset at
 * "00:00 as if UTC", which can be the other side of a change.
 */
export function nextPacificMidnight(now: Date): Date {
  const today = pacificWallClock(now.getTime());
  const midnightAsUtc = Date.UTC(today.year, today.month - 1, today.day + 1, 0, 0, 0);
  const firstGuess = midnightAsUtc - pacificOffsetMs(midnightAsUtc);
  return new Date(midnightAsUtc - pacificOffsetMs(firstGuess));
}

/** Reasons under `error.errors[].reason` and `error.details[].reason`, normalized. */
function youtubeReasons(body: unknown): Set<string> {
  const reasons = new Set<string>();
  const error = (body as { error?: { errors?: unknown; details?: unknown } } | null)?.error;
  for (const list of [error?.errors, error?.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      // `errors[]` uses camelCase (quotaExceeded) while `details[]` (ErrorInfo)
      // may use UPPER_SNAKE: compare with case and underscores removed.
      if (typeof reason === "string") reasons.add(reason.replace(/_/g, "").toLowerCase());
    }
  }
  return reasons;
}

/** Parse a response body as JSON from a clone, so the caller can still read the original. */
async function readJsonClone(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.clone().text());
  } catch {
    // Empty, not JSON, or the body was already consumed: not a body we can use.
    return null;
  }
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Is this response a platform rate limit or quota refusal? Returns the typed
 * error to throw, or null when it is not one (the caller's own error handling
 * then applies). Call it BEFORE assertOk or the client's own error building:
 *
 *   const limited = await classifyRateLimit("x", res);
 *   if (limited) throw limited;
 *
 * It reads a CLONE of the body, so the original stays readable for the caller
 * (assertOk logs it, the client parses it). Retry-at sources, in priority order,
 * are listed per platform below; the classification table is the plan's Task 4.
 */
export async function classifyRateLimit(
  platform: Platform,
  res: Response,
  now: number = Date.now(),
): Promise<RateLimitedError | null> {
  switch (platform) {
    case "x":
      return res.status === 429
        ? rateLimitedError(platform, "rate_limited", retryAtFromHeaders(res.headers, now))
        : null;

    case "linkedin":
    case "google_business_profile":
      return res.status === 429
        ? rateLimitedError(platform, "rate_limited", retryAfterAt(res.headers, now))
        : null;

    case "tiktok": {
      if (res.status === 429) {
        return rateLimitedError(platform, "rate_limited", retryAfterAt(res.headers, now));
      }
      // The same limit can arrive in the body of a 200 (video/init).
      const body = (await readJsonClone(res)) as { error?: { code?: unknown } } | null;
      return body?.error?.code === TIKTOK_RATE_LIMIT_CODE
        ? rateLimitedError(platform, "rate_limited", retryAfterAt(res.headers, now))
        : null;
    }

    case "youtube": {
      if (res.status === 429) {
        return rateLimitedError(platform, "rate_limited", retryAfterAt(res.headers, now));
      }
      if (res.status !== 403 && res.status !== 400) return null;
      const reasons = youtubeReasons(await readJsonClone(res));
      const resetAt = () => nextPacificMidnight(new Date(now)).getTime() + PACIFIC_RESET_GRACE_MS;
      if (res.status === 403) {
        if ([...reasons].some((r) => YOUTUBE_QUOTA_REASONS.has(r))) {
          return rateLimitedError(platform, "youtube_quota", resetAt());
        }
        if ([...reasons].some((r) => YOUTUBE_RATE_REASONS.has(r))) {
          return rateLimitedError(platform, "rate_limited", retryAfterAt(res.headers, now));
        }
        return null;
      }
      return reasons.has(YOUTUBE_UPLOAD_LIMIT_REASON)
        ? rateLimitedError(platform, "daily_limit", resetAt())
        : null;
    }

    case "instagram":
    case "facebook_page": {
      // Meta throttles with HTTP 400 and a body code, not 429, but a 429 counts too.
      if (res.status === 429) {
        return rateLimitedError(
          platform,
          "rate_limited",
          metaRetryAt(res.headers, now) ?? retryAfterAt(res.headers, now),
        );
      }
      if (res.ok) return null;
      const body = (await readJsonClone(res)) as {
        error?: { code?: unknown; error_subcode?: unknown };
      } | null;
      const code = asInteger(body?.error?.code);
      const subcode = asInteger(body?.error?.error_subcode);
      if (code === null) return null;
      if (
        platform === "instagram" &&
        code === INSTAGRAM_PUBLISH_LIMIT_CODE &&
        subcode === INSTAGRAM_PUBLISH_LIMIT_SUBCODE
      ) {
        return rateLimitedError(platform, "daily_limit", now + INSTAGRAM_PUBLISH_LIMIT_WAIT_MS);
      }
      if (!META_THROTTLE_CODES.has(code)) return null;
      if (code === 4 && subcode === META_SPAM_SUBCODE) return null;
      return rateLimitedError(
        platform,
        "rate_limited",
        metaRetryAt(res.headers, now) ?? retryAfterAt(res.headers, now),
      );
    }

    default:
      return null;
  }
}
