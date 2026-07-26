import type { PostJobStatus } from "@prisma/client";

/**
 * Stale in-flight PostJob policy.
 *
 * A PostJob has no terminal-state guarantee: it is created `pending` (or set
 * `in_progress` by publish/retry) and relies on an Inngest event to carry it to
 * `completed`/`failed`. If that event is never delivered — or the function dies
 * before writing per-platform results — the job stays non-terminal forever:
 *
 *  - nothing reaps it (the other crons sweep media, scheduled posts, metrics);
 *  - `POST /api/posts/[id]/retry` can't rescue it either, because retry flips
 *    *failed `PostJobResult` rows* and an orphan has none, so nothing is
 *    eligible and the caller gets a 409;
 *  - the UI shows it as publishing forever; and
 *  - because `pending`/`in_progress` are non-terminal, the media retention
 *    sweep can never reclaim its blob (see mediaRetention.ts) — a storage leak.
 *
 * Prod carried 10 such orphans from 2025-11 / 2026-01, six of them created in
 * the window when the Inngest keys were rotated. This module holds the pure
 * eligibility rule so it can be unit-tested; the cron that applies it lives in
 * inngest-functions.ts.
 */

/**
 * Statuses a job can be stuck in. These are exactly the non-terminal states
 * that a *dispatched* job passes through — deliberately NOT `draft` or
 * `scheduled`, which are non-terminal by design and may sit for weeks until the
 * user (or the due-scanner) promotes them.
 */
export const STALE_ELIGIBLE_STATUSES: readonly PostJobStatus[] = [
  "pending",
  "in_progress",
];

/**
 * How long a job may stay in-flight before the sweep calls it dead.
 *
 * Generous on purpose: a real publish uploads video to several platforms and
 * Inngest retries on top of that, so minutes are normal and the cost of being
 * wrong is high — prematurely failing a job that is still working would report
 * a failure for a post that then publishes anyway. Six hours is far beyond any
 * legitimate run while still bounding the UI lie and the blob leak to one day.
 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Jobs untouched since this instant are considered dead. */
export function staleCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_AFTER_MS);
}

export interface StalePostJobInput {
  status: PostJobStatus;
  /** Last write to the row — `@updatedAt`, so it advances on every transition. */
  updatedAt: Date;
}

/**
 * Whether a job is a dispatched job that has stopped making progress.
 *
 * Keys off `updatedAt`, not `createdAt`: a job that is genuinely moving through
 * its platforms rewrites the row as it goes, so an active long publish keeps
 * resetting its own clock and is never swept.
 */
export function isStalePostJob(job: StalePostJobInput, now: Date): boolean {
  if (!STALE_ELIGIBLE_STATUSES.includes(job.status)) {
    return false;
  }
  return job.updatedAt.getTime() < staleCutoff(now).getTime();
}
