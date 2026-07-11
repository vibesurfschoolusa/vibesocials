import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";

/**
 * Roadmap Phase 8 (analytics — post performance, §7.3) — selection logic for the
 * YouTube metrics sync cron, extracted from the Inngest function so the
 * "which results are eligible to fetch now" query is unit-testable with a mocked
 * prisma (mirrors `scheduledScanner.claimDueScheduledJobs`).
 */

/** Max results fetched per sync run; the hourly cadence drains any backlog. */
export const METRICS_SYNC_BATCH = 100;

/** A successful, fetchable YouTube post result. Carries the denormalized identity
 * the metric row stores (userId/platform/externalPostId), so a later connection
 * or result deletion never strands the metric. */
export interface EligibleMetricResult {
  /** The originating PostJobResult id — stored as the metric's OPTIONAL SetNull link. */
  resultId: string;
  /** Owner; both scopes the connection lookup and is denormalized onto the metric. */
  userId: string;
  platform: Platform;
  /** The YouTube video id (PostJobResult.externalPostId). */
  externalPostId: string;
}

/**
 * Select the batch of results eligible for a metric fetch right now: successful
 * `youtube` results with a non-null `externalPostId` (the video id).
 *
 * v1 orders by `createdAt desc` and bounds the batch to `take` — so each run
 * refreshes the most-recent posts (the ones whose "current" stats matter most).
 * NOTE (review Minor #3): this batch is GLOBAL across all users (no `userId`
 * scope), so with more than `take` recent YouTube posts in the system a single
 * high-volume user can fill a run and delay other users' refreshes. Effect is
 * staleness only — existing metric rows persist and are still served — never
 * data loss. Fairer scheduling (per-user round-robin, or ordering by metric
 * staleness to drain the long tail) is a deliberate future extension. The query
 * is platform-scoped to `youtube` because that is the only fetcher in v1
 * (extension point in the cron).
 */
export async function selectYouTubeMetricEligibleResults(
  take: number = METRICS_SYNC_BATCH,
): Promise<EligibleMetricResult[]> {
  const rows = await prisma.postJobResult.findMany({
    where: {
      platform: "youtube",
      status: "success",
      externalPostId: { not: null },
    },
    select: {
      id: true,
      externalPostId: true,
      // userId lives on the parent job (PostJobResult has no userId column).
      postJob: { select: { userId: true } },
    },
    orderBy: { createdAt: "desc" },
    take,
  });

  const eligible: EligibleMetricResult[] = [];
  for (const row of rows) {
    // `externalPostId` is `{ not: null }` in the WHERE, but Prisma still types it
    // `string | null`; narrow defensively and skip anything unexpected rather
    // than assert non-null.
    if (!row.externalPostId) {
      continue;
    }
    eligible.push({
      resultId: row.id,
      userId: row.postJob.userId,
      platform: "youtube",
      externalPostId: row.externalPostId,
    });
  }
  return eligible;
}
