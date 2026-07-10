import type { PostJobStatus } from "@prisma/client";

/**
 * Roadmap Phase 5 — pure, side-effect-free scheduling/draft helpers.
 *
 * Extracted here (no DB, no React) so the status guards, the `scheduledFor`
 * validation, and the datetime-local → UTC conversion can be unit-tested in
 * isolation and shared by the API routes, the cron due-scanner, and the
 * composer — one source of truth for every "can I do X to a job in status S?"
 * decision. Mirrors the `isMediaSweepEligible` / `parseRetryBody` pattern.
 */

/** What the composer asked for when creating a post. */
export type PostJobIntent = "immediate" | "scheduled" | "draft";

/**
 * How far in the future a `scheduledFor` must be to be accepted. The cron runs
 * every minute, so anything less than a minute out would be "due" almost
 * immediately — require a small buffer so "schedule" always means "later".
 */
export const SCHEDULE_BUFFER_MS = 60_000;

/**
 * Initial `PostJob.status` for a freshly created job of each intent:
 *  - immediate → `in_progress` (results are created up-front and the publish
 *    event is sent now — today's behavior);
 *  - scheduled → `scheduled` (no results, no event; the cron claims it when
 *    due and materializes results from the connections that exist THEN);
 *  - draft → `draft` (no results, no event; promoted via the publish endpoint).
 */
export function postJobStatusForIntent(intent: PostJobIntent): PostJobStatus {
  switch (intent) {
    case "scheduled":
      return "scheduled";
    case "draft":
      return "draft";
    case "immediate":
    default:
      return "in_progress";
  }
}

/**
 * Statuses whose content (caption/overrides/`scheduledFor`) may still be edited
 * (PATCH), which may be cancelled, or which may be published now — a job that
 * has already started running or finished is immutable. `scheduled` and `draft`
 * are the only pre-run states a user owns. The routes use this set directly in
 * their ATOMIC conditional `where: { status: { in: … } }` guards.
 */
export const MUTABLE_POST_JOB_STATUSES: readonly PostJobStatus[] = [
  "scheduled",
  "draft",
];

/**
 * Statuses whose PostJob row may be hard-deleted from the Queue: a `draft` the
 * user abandoned or a `cancelled` job they want to clear. A `scheduled` job must
 * be cancelled first (so it can't race the cron mid-claim); running/terminal
 * jobs are history and are never deleted here.
 */
export const DELETABLE_POST_JOB_STATUSES: readonly PostJobStatus[] = [
  "draft",
  "cancelled",
];

/** Result of validating a caller-supplied `scheduledFor`. */
export type ScheduledForValidation =
  | { ok: true; date: Date }
  | { ok: false; error: string };

/**
 * Validate a `scheduledFor` value from a request body. Accepts an ISO-8601
 * string (what the composer sends after converting its datetime-local input to
 * UTC). Rejects a missing value, an unparseable date, or a time that isn't at
 * least `bufferMs` in the future.
 */
export function validateScheduledFor(
  value: unknown,
  now: Date,
  bufferMs: number = SCHEDULE_BUFFER_MS,
): ScheduledForValidation {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "scheduledFor is required to schedule a post." };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "scheduledFor must be a valid date/time." };
  }

  if (date.getTime() < now.getTime() + bufferMs) {
    return {
      ok: false,
      error: "scheduledFor must be at least a minute in the future.",
    };
  }

  return { ok: true, date };
}

/**
 * Convert a browser `<input type="datetime-local">` value (local wall-clock,
 * e.g. `"2026-07-10T14:30"`, no timezone) to a UTC ISO-8601 string for the
 * `scheduledFor` field. Returns null for an empty/invalid value. `new Date(...)`
 * parses a timezone-less datetime-local string in the browser's local zone,
 * and `.toISOString()` normalizes it to UTC — the v1 "browser-local tz"
 * decision (spec §8 #3).
 */
export function localDateTimeToUtcIso(localValue: string): string | null {
  if (!localValue || localValue.trim() === "") return null;
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`) in the
 * local zone — the inverse of {@link localDateTimeToUtcIso}. Used for the
 * picker's `min` (earliest schedulable time) and to prefill the edit dialog
 * from a stored UTC `scheduledFor`.
 */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Best-effort local timezone label (e.g. "America/New_York") for UI hints. */
export function localTimeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time";
  } catch {
    return "your local time";
  }
}
