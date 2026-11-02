import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";

/**
 * Roadmap Phase 8 (analytics — post performance, §7.3) — selection logic for the
 * YouTube metrics sync cron, extracted from the Inngest function so the
 * "which results are eligible to fetch now" query is unit-testable with a mocked
 * prisma (mirrors `scheduledScanner.claimDueScheduledJobs`).
 */

/**
 * 2026-11-01 scale audit (jobs, YouTube metrics): the hourly sync refreshes the
 * results least recently CHECKED first, 50 ids per `videos.list` call, within a
 * per-run quota budget. It used to refresh the newest 100 results only, one call
 * each, so older videos stopped being refreshed.
 */

/** Results selected per page; a run reads up to {@link METRICS_MAX_PAGES_PER_RUN} pages. */
export const METRICS_PAGE_SIZE = 200;

/** Pages (`sync-page-<i>` steps) per run: at most 2,000 results an hour. */
export const METRICS_MAX_PAGES_PER_RUN = 10;

/**
 * YouTube quota units one run may spend. `videos.list` costs 1 unit a call, so
 * 300 x 24 runs = 7,200 a day out of the shared 10,000-unit general bucket
 * (`videos.insert` has its own bucket of 100 calls/day), which leaves the rest
 * for other callers. Quota resets at midnight Pacific Time.
 * https://developers.google.com/youtube/v3/determine_quota_cost
 */
export const METRICS_UNITS_PER_RUN = 300;

/**
 * A result checked within this long is not selected again. It MUST stay below the
 * cron interval (hourly): run N+1 selects with `now' - this`, and a result that
 * run N stamped late in its page is eligible only if `now'` is at least that far
 * past the stamp. At exactly one hour that is true only when run N+1 starts as
 * late in its hour as run N did, which start-time jitter makes close to a coin
 * flip; every miss skips the whole queue for that hour and degrades the cadence
 * from hourly to 1.5-2 h. 50 minutes leaves 10 minutes of slack under the tick.
 * (Controller ruling R27.)
 */
export const METRICS_MIN_REFRESH_MS = 3_000_000;

/**
 * Video ids per `videos.list` call. UNCONFIRMED: 50 comes from secondary
 * sources, not the official reference (plan U4). A wrong cap only leaves metrics
 * stale: the call fails and its ids are retried an hour later.
 * https://developers.google.com/youtube/v3/docs/videos/list
 */
export const YOUTUBE_STATS_IDS_PER_CALL = 50;

/** A successful, fetchable YouTube post result. Carries the denormalized identity
 * the metric row stores (userId/platform/externalPostId), so a later connection
 * or result deletion never strands the metric. */
export interface EligibleMetricResult {
  /** The originating PostJobResult id — stored as the metric's OPTIONAL SetNull link. */
  resultId: string;
  /** The post's creator; denormalized onto the metric for legacy compat (Team
   *  Workspaces: the metric row's `userId` is stamped from the connection's
   *  connector instead — see inngest-functions.ts — but this field stays for
   *  attribution/logging). */
  userId: string;
  /** Team Workspaces (Task 5) — the post's tenant. Scopes the connection
   *  lookup (a shared workspace connection, not a personal-workspace bridge)
   *  and is stamped onto the metric row. */
  workspaceId: string;
  platform: Platform;
  /** The YouTube video id (PostJobResult.externalPostId). */
  externalPostId: string;
}

/**
 * Select one page of results eligible for a metric fetch right now: successful
 * `youtube` results with a non-null `externalPostId` (the video id) that were
 * never checked or were last checked more than {@link METRICS_MIN_REFRESH_MS}
 * before `now`.
 *
 * 2026-11-01 scale audit (jobs, YouTube metrics): ordered LEAST-RECENTLY-CHECKED
 * first (`metricsCheckedAt` ascending, never-checked first), then newest post
 * first. `metricsCheckedAt` is stamped on every attempt - found, not found or
 * error - so a deleted or private video (which never gets a metric row) moves to
 * the back of the line after one try instead of sorting first forever, as it
 * would have by `PostMetric.fetchedAt`. This replaces the v1 "newest 100 posts"
 * order, which never reached older videos (review Minor #3). The batch is still
 * GLOBAL across users and workspaces (no scope), so the run's unit budget, not
 * the selector, bounds the cost. Served by
 * `@@index([platform, status, metricsCheckedAt])`. The query is
 * platform-scoped to `youtube` because that is the only fetcher in v1
 * (extension point in the cron).
 */
export async function selectYouTubeMetricEligibleResults(
  take: number = METRICS_PAGE_SIZE,
  now: Date = new Date(),
): Promise<EligibleMetricResult[]> {
  const rows = await prisma.postJobResult.findMany({
    where: {
      platform: "youtube",
      status: "success",
      externalPostId: { not: null },
      OR: [
        { metricsCheckedAt: null },
        { metricsCheckedAt: { lt: new Date(now.getTime() - METRICS_MIN_REFRESH_MS) } },
      ],
    },
    select: {
      id: true,
      externalPostId: true,
      // userId/workspaceId live on the parent job (PostJobResult has neither
      // column itself).
      postJob: { select: { userId: true, workspaceId: true } },
    },
    orderBy: [{ metricsCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
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
      workspaceId: row.postJob.workspaceId,
      platform: "youtube",
      externalPostId: row.externalPostId,
    });
  }
  return eligible;
}
