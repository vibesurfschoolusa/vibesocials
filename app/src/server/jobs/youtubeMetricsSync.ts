import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  METRICS_PAGE_SIZE,
  YOUTUBE_STATS_IDS_PER_CALL,
  selectYouTubeMetricEligibleResults,
  type EligibleMetricResult,
} from "@/server/jobs/metricsScanner";
import { refreshConnectionToken } from "@/server/platforms/connectionRefresh";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";
import { fetchYouTubeVideoStatisticsBatch, hasAnyStatistic } from "@/server/platforms/youtubeMetrics";

// Server-only: touches prisma.
//
// 2026-11-01 scale audit (jobs, YouTube metrics): one PAGE of the hourly metrics
// sync (`youtubePostMetricsSync`, inngest-functions.ts, one `sync-page-<i>` step
// per page). The cron used to refresh the newest 100 results globally, one
// `videos.list` call per video, so older videos stopped being refreshed. A page
// now takes the results least recently CHECKED first (metricsScanner.ts),
// groups them per workspace connection, asks for 50 ids per call (1 quota unit
// a call, V9) and stops at the run's unit budget or at the first quota refusal.
//
// STRICTLY read-only w.r.t. posting: it only reads engagement counts, upserts
// `PostMetric` rows and stamps `PostJobResult.metricsCheckedAt`. It never
// touches a result's status or re-publishes anything.

/**
 * In-step time budget of one page. Each page is its own step (its own invocation,
 * capped at 300 s on Vercel); after the budget the page stops between calls and
 * returns what it did, and the next page resumes with the results it did not
 * reach. The budget plus at most one more request (30 s) stays well under the cap.
 * Mirrors RETENTION_BATCH_BUDGET_MS (mediaRetentionBatch.ts).
 */
export const METRICS_PAGE_BUDGET_MS = 150_000;

/**
 * What one page did. Every count is in RESULTS and
 * `attempted = updated + notFound + errors`. SEC: counts only, never a token,
 * an email or a video id (it is a step output, which Inngest persists).
 */
export interface MetricsPageResult {
  /** Results checked and stamped this page (`metricsCheckedAt`). 0 ends the run. */
  attempted: number;
  /** Results whose video was found with at least one count and upserted. */
  updated: number;
  /** Video absent from the response (deleted/private) or present with all-null counts: nothing written. */
  notFound: number;
  /** Failed call, workspace without a usable connection, or failed upsert. */
  errors: number;
  /** `videos.list` calls made = quota units spent (a refused call counts). */
  unitsUsed: number;
  /** YouTube refused a call for quota or rate: no further call this run would succeed. */
  stop: boolean;
}

interface ResolvedConnection {
  accessToken: string;
  /** Whoever connected this YouTube account; stamped onto the PostMetric row. */
  connectorUserId: string;
}

/**
 * Resolve a workspace's YouTube connection to a usable access token, or null
 * when it is unavailable (gone, flagged `needsReconnect`, refresh failed).
 *
 * Cached for the page (`cache`): a workspace with several videos loads the
 * connection and refreshes the token once, and one workspace's reconnect or
 * refresh failure skips all its results without re-hitting the DB or Google.
 * Team Workspaces (Task 5): keyed by workspaceId (the shared connection), NOT
 * userId, since the post's creator may not be who connected the platform.
 */
async function resolveConnection(
  workspaceId: string,
  cache: Map<string, ResolvedConnection | null>,
): Promise<ResolvedConnection | null> {
  const cached = cache.get(workspaceId);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: ResolvedConnection | null = null;
  try {
    const connection = await prisma.socialConnection.findUnique({
      where: { workspaceId_platform: { workspaceId, platform: "youtube" } },
    });
    // Skip a gone (disconnected) or `needsReconnect`-flagged connection - do NOT
    // push a known-bad token through refresh.
    if (connection && !connection.needsReconnect) {
      let active = connection;
      if (active.expiresAt && active.expiresAt.getTime() < Date.now()) {
        // Shared Google refresh: writes ONLY accessToken/expiry, NEVER
        // refreshToken (see googleTokens.ts). May throw + mark needsReconnect on
        // invalid_grant - caught here so the token stays null.
        // 2026-11-01 scale audit (jobs, token refresh): under the per-connection
        // lock, so a publish or the health sweep refreshing the same connection
        // at once is serialized, and a refresh that finished first is reused
        // instead of repeated.
        active = await refreshConnectionToken(active, (current) => refreshGoogleToken(current));
      }
      if (active.accessToken) {
        resolved = { accessToken: active.accessToken, connectorUserId: active.userId };
      }
    }
  } catch (error) {
    logger.error("[Inngest] YouTube metrics: connection resolve failed (skipping workspace)", {
      workspaceId,
      error,
    });
    resolved = null;
  }

  cache.set(workspaceId, resolved);
  return resolved;
}

/**
 * Run one page of the sync.
 *
 * @param opts.unitsLeft quota units the run may still spend. Calls stop when it is
 *   used up, and with 0 left nothing is even selected.
 * @param opts.now the instant this page treats as "now" (selection cutoff, the
 *   `metricsCheckedAt` stamp and `PostMetric.fetchedAt`); defaults to the clock.
 *
 * Every result the page ATTEMPTED is stamped with `metricsCheckedAt = now` in one
 * statement at the end - found, not found or failed alike - so a video that
 * can never produce a metric (deleted, private, workspace disconnected) goes to
 * the back of the line instead of sorting first on every run. NOT stamped, so
 * they stay the stalest for the next run: results the unit/time budget did not
 * reach, and the chunk YouTube refused for quota or rate (it was never checked).
 * If the page crashes before the stamp, the whole page is selected again and
 * redone; the upsert is idempotent (keyed on (platform, externalPostId)).
 *
 * Isolated per workspace and per video: one workspace's missing connection, one
 * failed call or one failed upsert never sinks the page. An unexpected database
 * error on the select or the stamp does throw, and Inngest retries the step.
 *
 * v1 = YouTube ONLY. The selector is platform-scoped to `youtube` and this loop
 * assumes YouTube. EXTENSION POINT: to add a platform, implement a per-platform
 * batch fetcher with the same best-effort contract as
 * `fetchYouTubeVideoStatisticsBatch`, widen the selector's platform filter, and
 * branch on `item.platform` below. X (paid API tiers), Google Business Profile
 * (no per-post insight API) and LinkedIn personal shares (expose little) are
 * intentionally out of scope for v1 (spec §7.3).
 */
export async function syncYouTubeMetricsPage(opts: {
  unitsLeft: number;
  now?: Date;
}): Promise<MetricsPageResult> {
  const result: MetricsPageResult = {
    attempted: 0,
    updated: 0,
    notFound: 0,
    errors: 0,
    unitsUsed: 0,
    stop: false,
  };
  if (opts.unitsLeft <= 0) {
    return result;
  }

  const now = opts.now ?? new Date();
  const eligible = await selectYouTubeMetricEligibleResults(METRICS_PAGE_SIZE, now);
  if (eligible.length === 0) {
    return result;
  }

  // Group per workspace connection, in the order of each workspace's stalest
  // result, so the budget is spent on the stalest videos first.
  const byWorkspace = new Map<string, EligibleMetricResult[]>();
  for (const item of eligible) {
    const group = byWorkspace.get(item.workspaceId);
    if (group) {
      group.push(item);
    } else {
      byWorkspace.set(item.workspaceId, [item]);
    }
  }

  const startedAt = Date.now();
  const connections = new Map<string, ResolvedConnection | null>();
  const attemptedIds: string[] = [];
  // Checked before each call, and before resolving a workspace's connection (a
  // token refresh is not worth doing for a call that will not be made).
  const budgetSpent = () =>
    result.unitsUsed >= opts.unitsLeft || Date.now() - startedAt >= METRICS_PAGE_BUDGET_MS;

  workspaces: for (const [workspaceId, items] of byWorkspace) {
    if (budgetSpent()) {
      break;
    }
    const connection = await resolveConnection(workspaceId, connections);
    if (!connection) {
      // No usable connection: no call to make, but the attempt is recorded so
      // these results do not sort first on every run and starve the rest.
      result.errors += items.length;
      attemptedIds.push(...items.map((item) => item.resultId));
      continue;
    }

    for (let from = 0; from < items.length; from += YOUTUBE_STATS_IDS_PER_CALL) {
      if (budgetSpent()) {
        break workspaces;
      }

      const chunk = items.slice(from, from + YOUTUBE_STATS_IDS_PER_CALL);
      const fetched = await fetchYouTubeVideoStatisticsBatch(
        chunk.map((item) => item.externalPostId),
        connection.accessToken,
      );
      result.unitsUsed += 1;

      if (!fetched.ok) {
        if (fetched.quotaExceeded) {
          // The whole project's quota (or rate) is gone: every further call is
          // refused too. This chunk was never checked, so it is not stamped.
          result.stop = true;
          break workspaces;
        }
        result.errors += chunk.length;
        attemptedIds.push(...chunk.map((item) => item.resultId));
        continue;
      }

      for (const item of chunk) {
        attemptedIds.push(item.resultId);
        const video = fetched.byId.get(item.externalPostId);
        // Absent from the response (deleted/private) OR present but carrying no
        // parseable statistics: do NOT overwrite a prior good snapshot with
        // all-null counts - leave the last-known metric intact (review Minor
        // #2/#5; being found alone doesn't prove there's data).
        if (!video || !hasAnyStatistic(video.stats)) {
          result.notFound += 1;
          continue;
        }

        try {
          // NOTE (review Minor #1, deferred): views/likes/comments are stored as
          // 32-bit Int. A count exceeding 2,147,483,647 would fail the write (and
          // be counted as an item error below). Not reachable for this app's
          // audience; widen these columns to BigInt if it ever serves channels
          // with billions of views (also convert bigint->Number at the DTO).
          await prisma.postMetric.upsert({
            where: {
              platform_externalPostId: {
                platform: "youtube",
                externalPostId: item.externalPostId,
              },
            },
            create: {
              // Team Workspaces (Task 5): stamped from the CONNECTION's connector
              // (whoever connected this YouTube account) rather than the post's
              // creator - see EligibleMetricResult.userId's doc comment
              // (metricsScanner.ts) for the "legacy compat" rationale.
              userId: connection.connectorUserId,
              workspaceId: item.workspaceId,
              platform: "youtube",
              externalPostId: item.externalPostId,
              postJobResultId: item.resultId,
              views: video.stats.views,
              likes: video.stats.likes,
              comments: video.stats.comments,
              // videos.list statistics does not expose shareCount -> null (never 0).
              shares: null,
              raw: video.raw as Prisma.InputJsonValue,
              fetchedAt: now,
            },
            update: {
              userId: connection.connectorUserId,
              postJobResultId: item.resultId,
              views: video.stats.views,
              likes: video.stats.likes,
              comments: video.stats.comments,
              shares: null,
              raw: video.raw as Prisma.InputJsonValue,
              fetchedAt: now,
            },
          });
          result.updated += 1;
        } catch (error) {
          result.errors += 1;
          logger.error("[Inngest] YouTube metrics: failed to sync item", {
            resultId: item.resultId,
            externalPostId: item.externalPostId,
            error,
          });
        }
      }
    }
  }

  if (attemptedIds.length > 0) {
    // Raw UPDATE, not `updateMany`: Prisma's `@updatedAt` would bump
    // PostJobResult.updatedAt on every hourly stamp, and publish-health
    // (/api/insights/publish-health) reads that column as "when the result
    // finished" - every old success would re-enter its window. Only
    // metricsCheckedAt changes here. The bound Date is a timestamptz while the
    // column is timestamp(3) holding UTC wall-clock time, so it is converted AT
    // TIME ZONE 'UTC' (see claimDueScheduledJobs, scheduledScanner.ts).
    await prisma.$executeRaw`
      UPDATE "PostJobResult"
      SET "metricsCheckedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ANY(${attemptedIds}::text[])`;
  }
  result.attempted = attemptedIds.length;
  return result;
}
