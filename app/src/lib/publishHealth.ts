import type { Platform } from "@prisma/client";

/**
 * Publish health — per-platform success rates over a recent window.
 *
 * Built from PostJobResult rows the app already writes, so it works for EVERY
 * platform (unlike PostMetric, which only YouTube populates today) and needs no
 * provider API. This is the answer to "is publishing actually working?", which
 * until now could only be reconstructed by reading the database by hand.
 *
 * Pure: no Date.now(), no DB — the caller passes `now` and the rows.
 */

export interface PlatformPublishHealth {
  platform: Platform;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Whole percent rounded down, 0-100: 100 only when nothing failed. */
  successRate: number;
}

export interface PublishHealthSummary {
  platforms: PlatformPublishHealth[];
  overall: {
    attempted: number;
    succeeded: number;
    failed: number;
    /** Whole percent, or null when nothing finished in the window. */
    successRate: number | null;
  };
}

/** A finished per-platform outcome. `pending` rows are ignored — nothing to score. */
export interface PublishHealthInput {
  platform: string;
  status: string;
  /** When the result reached its terminal state (PostJobResult.updatedAt). */
  finishedAt: Date | string;
}

/**
 * One (platform, status) group of finished results, already counted by the
 * database (the publish-health route's `groupBy`).
 */
export interface PublishHealthCountRow {
  platform: string;
  status: string;
  count: number;
}

/**
 * Whole percent, rounded down, so it reads 100 only when nothing failed (R47
 * new-customer L1: 199 of 200 rounded to a green 100%). Multiplied first, so
 * an exact rate such as 29 of 100 isn't floored below itself by float error.
 */
function successRateOf(succeeded: number, attempted: number): number {
  return Math.floor((succeeded * 100) / attempted);
}

/**
 * The summary for pre-aggregated counts. 2026-11-01 scale audit (db M5, web W16):
 * the route no longer loads rows, so the counts are exact for any tenant. The
 * caller has already applied the window; `pending` (or any other non-terminal)
 * groups are ignored here too, and repeated (platform, status) groups add up.
 */
export function summarizePublishHealthCounts(
  rows: PublishHealthCountRow[],
): PublishHealthSummary {
  const byPlatform = new Map<string, { succeeded: number; failed: number }>();

  for (const row of rows) {
    if (row.status !== "success" && row.status !== "failed") continue;
    if (!(row.count > 0)) continue;

    const bucket = byPlatform.get(row.platform) ?? { succeeded: 0, failed: 0 };
    if (row.status === "success") bucket.succeeded += row.count;
    else bucket.failed += row.count;
    byPlatform.set(row.platform, bucket);
  }

  const platforms: PlatformPublishHealth[] = [...byPlatform.entries()]
    .map(([platform, { succeeded, failed }]) => {
      const attempted = succeeded + failed;
      return {
        platform: platform as Platform,
        attempted,
        succeeded,
        failed,
        successRate: successRateOf(succeeded, attempted),
      };
    })
    // Busiest first — that's where a dip matters most.
    .sort((a, b) => b.attempted - a.attempted || a.platform.localeCompare(b.platform));

  const succeeded = platforms.reduce((sum, p) => sum + p.succeeded, 0);
  const failed = platforms.reduce((sum, p) => sum + p.failed, 0);
  const attempted = succeeded + failed;

  return {
    platforms,
    overall: {
      attempted,
      succeeded,
      failed,
      successRate: attempted === 0 ? null : successRateOf(succeeded, attempted),
    },
  };
}

export function summarizePublishHealth(
  results: PublishHealthInput[],
  now: Date,
  windowDays: number,
): PublishHealthSummary {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const counts = new Map<string, PublishHealthCountRow>();

  for (const result of results) {
    if (result.status !== "success" && result.status !== "failed") continue;
    const finished = new Date(result.finishedAt).getTime();
    if (Number.isNaN(finished) || finished < cutoff) continue;

    const key = `${result.platform}:${result.status}`;
    const row = counts.get(key) ?? { platform: result.platform, status: result.status, count: 0 };
    row.count++;
    counts.set(key, row);
  }

  return summarizePublishHealthCounts([...counts.values()]);
}
