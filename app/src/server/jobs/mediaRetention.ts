import type { PostJobStatus } from "@prisma/client";

/**
 * Roadmap Phase 1 — retention policy for persisted media blobs.
 *
 * Media blobs are no longer deleted on every post; they persist so media can be
 * reused/retried and browsed in the library. Storage is instead bounded by a
 * daily retention sweep. This module holds the pure, side-effect-free pieces of
 * that policy so the eligibility rule can be unit-tested in isolation.
 */

/**
 * Days a *posted* media blob is retained after its last use before the sweep may
 * remove it. Owner-tunable (Open decision #1). Never-posted library uploads are
 * exempt regardless of this window.
 */
export const RETENTION_DAYS = 30;

/**
 * PostJob statuses that mean the job is DONE (terminal). Any status NOT in this
 * set is treated as non-terminal / active — a media item referenced by a
 * non-terminal job is never swept, because that job may still publish its blob.
 *
 * Non-terminal (kept): `pending`, `in_progress`, and Roadmap Phase 5's
 * `scheduled` / `draft` (an upcoming post may still publish its blob — spec §2
 * enumerates exactly these as non-terminal). Terminal (sweepable/deletable):
 * `completed`, `failed`, and `cancelled` — a cancelled job will NEVER publish,
 * so pinning its media forever would be a storage leak AND would wrongly 409
 * media-delete for media referenced only by a cancelled job. Callers query with
 * `status: { notIn: TERMINAL_POST_JOB_STATUSES }` to find non-terminal jobs.
 */
export const TERMINAL_POST_JOB_STATUSES: readonly PostJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MediaSweepEligibilityInput {
  /** When the blob was already soft-deleted (removed), else null. */
  deletedAt: Date | null;
  /**
   * True if the item is referenced by at least one PostJob whose status is
   * non-terminal (e.g. `pending`/`in_progress`, and future `scheduled`/`draft`).
   */
  hasNonTerminalJob: boolean;
  /**
   * True if the item is referenced by at least one PostJob at all — i.e. it was
   * actually posted, as opposed to a never-posted library upload.
   */
  hasAnyJob: boolean;
  /** Last time the media was attached to a post, else null (never stamped). */
  lastUsedAt: Date | null;
  /** Row creation time — the age basis fallback when `lastUsedAt` is null. */
  createdAt: Date;
  /** The instant the eligibility is being evaluated. */
  now: Date;
  /** Retention window, in days. */
  retentionDays: number;
}

/**
 * Pure predicate: may this media item's blob be removed by the retention sweep?
 *
 * Eligible only when ALL hold:
 *  - the blob is not already removed (`deletedAt == null`);
 *  - no non-terminal referencing PostJob exists (an active/scheduled post may
 *    still need the blob);
 *  - it was actually posted at least once (`hasAnyJob`) — never-posted library
 *    uploads are EXEMPT from age-based sweeping so the "persistent library"
 *    promise holds;
 *  - it is posted-and-stale: `COALESCE(lastUsedAt, createdAt)` is strictly older
 *    than the retention window (`< now - retentionDays`).
 *
 * Deterministic and side-effect-free: the sweep re-evaluates this inside a
 * transaction against fresh data to close the check-then-act race.
 */
export function isMediaSweepEligible(input: MediaSweepEligibilityInput): boolean {
  const {
    deletedAt,
    hasNonTerminalJob,
    hasAnyJob,
    lastUsedAt,
    createdAt,
    now,
    retentionDays,
  } = input;

  // Blob already removed — nothing to sweep.
  if (deletedAt !== null) return false;

  // An active/scheduled post may still publish this blob — keep it.
  if (hasNonTerminalJob) return false;

  // Never-posted library upload — exempt from age-based sweeping.
  if (!hasAnyJob) return false;

  // Posted-and-stale: age basis strictly older than the retention window.
  const ageBasis = lastUsedAt ?? createdAt;
  const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
  return ageBasis.getTime() < cutoff;
}
