import type { Platform, Prisma, SocialConnection } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { storyPlatformsOf } from "@/lib/storyPlacement";
import {
  FACEBOOK_METRICS_ITEMS_PER_BATCH,
  fetchFacebookPostMetricsBatch,
  hasAnyCount,
  type FacebookPostKind,
  type PostMetricsBatch,
} from "@/server/platforms/facebookMetrics";
import { ensureFreshInstagramToken } from "@/server/platforms/instagramClient";
import { INSTAGRAM_METRICS_IDS_PER_BATCH, fetchInstagramMediaMetricsBatch } from "@/server/platforms/instagramMetrics";
import { ensureFreshLinkedInToken } from "@/server/platforms/linkedinClient";
import { LINKEDIN_URNS_PER_REQUEST, fetchLinkedInShareStatisticsBatch } from "@/server/platforms/linkedinMetrics";
import { ensureFreshPinterestToken } from "@/server/platforms/pinterestClient";
import { fetchPinterestPinMetricsBatch } from "@/server/platforms/pinterestMetrics";

/**
 * Post numbers for Instagram, Facebook Pages, LinkedIn company pages and
 * Pinterest (2026-11-10). The daily `social-post-metrics-sync` cron runs one
 * step, `syncSocialPostMetrics`: it reads the numbers of recent published posts
 * with the scopes the app already holds (per platform: the fetchers in
 * server/platforms/*Metrics.ts) and upserts one PostMetric row per post, where
 * the YouTube numbers live.
 *
 * Same contract as the hourly YouTube page (youtubeMetricsSync.ts): read-only
 * towards posting (no result status, no post is touched), keyed by
 * (platform, externalPostId) so a repeated run rewrites the same rows, and every
 * result looked at is stamped `metricsCheckedAt` in ONE raw statement at the
 * end, found, not found or failed alike. Not stamped, so they come first
 * tomorrow: results not reached in time and results a platform's rate limit
 * kept us from asking about. A result whose connection is gone, needs
 * reconnecting, or belongs to another workspace is stamped too: tomorrow asks
 * again, and it cannot starve the others meanwhile.
 *
 * The time bound is the review check's (reviewAlerts.ts): no new request starts
 * after SOCIAL_METRICS_BUDGET_MS.
 *
 * SEC: the output is counts only; logs name the platform and the connection id,
 * never a token, a post id or a page name; `raw` holds counts only.
 */

export const SOCIAL_METRICS_PLATFORMS = ["instagram", "facebook_page", "linkedin", "pinterest"] as const;
export type SocialMetricsPlatform = (typeof SOCIAL_METRICS_PLATFORMS)[number];

/** No new request starts after this long; what is left waits for tomorrow. */
export const SOCIAL_METRICS_BUDGET_MS = 150_000;
/** Only posts published within this long are read. */
export const SOCIAL_METRICS_MAX_AGE_MS = 60 * 86_400_000;
/** A result checked within this long is not read again: below the daily cron, so start jitter never skips a day. */
export const SOCIAL_METRICS_MIN_REFRESH_MS = 20 * 3_600_000;
/** Results selected per run: 60 days of a few posts a day for each of many workspaces. */
export const SOCIAL_METRICS_SELECT_LIMIT = 2_000;
/**
 * Pins read per connection per run: Pinterest takes one request per Pin. The
 * rest of a busy board's Pins are least recently checked tomorrow and go first.
 */
export const PINTEREST_PINS_PER_CONNECTION = 25;

export interface SocialMetricEligibleResult {
  resultId: string;
  platform: SocialMetricsPlatform;
  externalPostId: string;
  /** The connection that published it; null when that connection was removed. */
  socialConnectionId: string | null;
  /** The post's tenant (from its job): the metric row's workspace. */
  workspaceId: string;
  /** When the result finished (`updatedAt`; the metrics stamp never moves it). */
  publishedAt: Date;
  /** The post's file is a video (Facebook reads a video differently). */
  isVideo: boolean;
  /**
   * Its job sent this platform a Story (publishMetadata, lib/storyPlacement.ts).
   * A Story has no lasting numbers: the sync asks nothing for it and only stamps it.
   */
  isStory: boolean;
}

/**
 * The results to read now: successful ones with an id on the four platforms,
 * finished within SOCIAL_METRICS_MAX_AGE_MS, never checked or checked more than
 * SOCIAL_METRICS_MIN_REFRESH_MS ago; least recently checked first, then newest.
 */
export async function selectSocialMetricEligibleResults(
  now: Date,
  take: number = SOCIAL_METRICS_SELECT_LIMIT,
): Promise<SocialMetricEligibleResult[]> {
  const rows = await prisma.postJobResult.findMany({
    where: {
      platform: { in: [...SOCIAL_METRICS_PLATFORMS] },
      status: "success",
      externalPostId: { not: null },
      updatedAt: { gte: new Date(now.getTime() - SOCIAL_METRICS_MAX_AGE_MS) },
      OR: [
        { metricsCheckedAt: null },
        { metricsCheckedAt: { lt: new Date(now.getTime() - SOCIAL_METRICS_MIN_REFRESH_MS) } },
      ],
      // No condition on publishMetadata here: a feed post's job has no
      // placement path (often no snapshot at all), and a NOT over that NULL
      // comparison would drop every ordinary post. Stories are recognised in
      // code below, from the selected snapshot.
    },
    select: {
      id: true,
      platform: true,
      externalPostId: true,
      socialConnectionId: true,
      updatedAt: true,
      postJob: { select: { workspaceId: true, publishMetadata: true, mediaItem: { select: { mimeType: true } } } },
    },
    orderBy: [{ metricsCheckedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
    take,
  });

  const eligible: SocialMetricEligibleResult[] = [];
  for (const row of rows) {
    if (!row.externalPostId || !(SOCIAL_METRICS_PLATFORMS as readonly Platform[]).includes(row.platform)) continue;
    eligible.push({
      resultId: row.id,
      platform: row.platform as SocialMetricsPlatform,
      externalPostId: row.externalPostId,
      socialConnectionId: row.socialConnectionId,
      workspaceId: row.postJob.workspaceId,
      publishedAt: row.updatedAt,
      isVideo: (row.postJob.mediaItem?.mimeType ?? "").startsWith("video/"),
      // The one place a Story is recognised, by the rule the rest of the app uses.
      isStory: (storyPlatformsOf(row.postJob.publishMetadata) as Platform[]).includes(row.platform),
    });
  }
  return eligible;
}

/** What one run did. Counts are in results unless named otherwise. SEC: counts only. */
export interface SocialMetricsSyncResult {
  selected: number;
  /** Stamped: `updated + notFound + errors + skippedOtherWorkspace + stories`. */
  attempted: number;
  /** A row was written. */
  updated: number;
  /** A row for the same post already belongs to another workspace: left alone. */
  skippedOtherWorkspace: number;
  /** Results sent as a Story: nothing asked, nothing written, stamped. */
  stories: number;
  /** The platform no longer has the post, or gave no number for it: nothing written. */
  notFound: number;
  /** The platform's answer was unusable, the write failed, or the connection was skipped. */
  errors: number;
  /** Connections not asked: gone, needing reconnecting, another workspace's, or no usable token. */
  skippedConnections: number;
  /** Not reached (time or a rate limit): not stamped, first in line tomorrow. */
  left: number;
  /** Platforms that refused for rate or quota this run. */
  rateLimitedPlatforms: number;
}

function errorFields(error: unknown) {
  return {
    error: error instanceof Error ? error.name : "unknown",
    code: (error as { code?: unknown } | null)?.code,
  };
}

/** The connection's token, ready to use, or null when the connection cannot be read with. */
async function usableToken(connection: SocialConnection): Promise<string | null> {
  switch (connection.platform) {
    case "linkedin":
      return (await ensureFreshLinkedInToken(connection)).accessToken || null;
    case "pinterest":
      return (await ensureFreshPinterestToken(connection)).accessToken || null;
    case "instagram":
      return ensureFreshInstagramToken(connection).accessToken || null;
    default:
      // A Facebook Page token has no refresh (facebookPageClient.ts).
      return connection.accessToken || null;
  }
}

function linkedinOrganizationUrn(connection: SocialConnection): string | null {
  const organizations = (connection.metadata as { organizations?: Array<{ id?: unknown }> } | null)?.organizations;
  const id = Array.isArray(organizations) ? organizations[0]?.id : undefined;
  // The page the publish client posts as (linkedinClient.ts: the first organization).
  return typeof id === "string" || typeof id === "number" ? `urn:li:organization:${id}` : null;
}

function facebookKind(item: SocialMetricEligibleResult): FacebookPostKind {
  // A post with several photos is stored as the feed post's "<page>_<post>" id.
  if (item.externalPostId.includes("_")) return "post";
  return item.isVideo ? "video" : "photo";
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reads and stores the numbers of every eligible result, connection by
 * connection, until SOCIAL_METRICS_BUDGET_MS has passed (`clock` is the real
 * clock). One connection's or platform's failure is logged and never stops the
 * others; a rate limit stops that platform for the run. An unexpected database
 * error on the select or the stamp throws, and Inngest retries the step.
 */
export async function syncSocialPostMetrics(
  now: Date,
  clock: () => number = Date.now,
): Promise<SocialMetricsSyncResult> {
  const startedAt = clock();
  const timeUp = () => clock() - startedAt > SOCIAL_METRICS_BUDGET_MS;
  const eligible = await selectSocialMetricEligibleResults(now);
  const result: SocialMetricsSyncResult = {
    selected: eligible.length,
    attempted: 0,
    updated: 0,
    skippedOtherWorkspace: 0,
    stories: 0,
    notFound: 0,
    errors: 0,
    skippedConnections: 0,
    left: 0,
    rateLimitedPlatforms: 0,
  };
  if (eligible.length === 0) return result;

  // A Story makes no request and gets no row. It is stamped with the rest, so
  // it goes to the back of the queue instead of sorting first ("never checked")
  // on every run for 60 days and taking real posts' places.
  const stamped: string[] = [];
  for (const item of eligible) {
    if (!item.isStory) continue;
    result.stories += 1;
    stamped.push(item.resultId);
  }

  // Grouped by the connection that published each result, in the order of each
  // group's stalest result. A removed connection's results form one group per platform.
  const groups = new Map<string, SocialMetricEligibleResult[]>();
  for (const item of eligible) {
    if (item.isStory) continue;
    const key = item.socialConnectionId ?? `none:${item.platform}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const limited = new Set<SocialMetricsPlatform>();

  const skip = (items: SocialMetricEligibleResult[]) => {
    result.skippedConnections += 1;
    result.errors += items.length;
    stamped.push(...items.map((item) => item.resultId));
  };

  /** Writes what one batch learned about `items`. */
  const record = async (
    items: SocialMetricEligibleResult[],
    batch: PostMetricsBatch,
    connection: SocialConnection,
  ) => {
    for (const item of items) {
      const id = item.externalPostId;
      if (batch.unchecked.has(id)) {
        result.left += 1;
        continue;
      }
      stamped.push(item.resultId);
      if (batch.failed.has(id)) {
        result.errors += 1;
        continue;
      }
      const found = batch.byId.get(id);
      // Gone, or present with no number: an earlier good row is left as it is.
      if (!found || !hasAnyCount(found.counts)) {
        result.notFound += 1;
        continue;
      }
      try {
        const numbers = {
          views: found.counts.views,
          likes: found.counts.likes,
          comments: found.counts.comments,
          shares: found.counts.shares,
          clicks: found.counts.clicks,
          saves: found.counts.saves,
          raw: found.raw as Prisma.InputJsonValue,
          fetchedAt: now,
        };
        await prisma.postMetric.upsert({
          // Matches only this workspace's row. A row for the same post owned by
          // another workspace is not matched, so the create hits the unique key
          // (P2002, below) and that row is left as it is.
          where: {
            platform_externalPostId: { platform: item.platform, externalPostId: id },
            workspaceId: item.workspaceId,
          },
          // The workspace is the result's; the connection was checked to be of the same one.
          create: {
            userId: connection.userId,
            workspaceId: item.workspaceId,
            platform: item.platform,
            externalPostId: id,
            postJobResultId: item.resultId,
            ...numbers,
          },
          // Only the numbers this read asked for: a read that left one out (the
          // Facebook fallback without comment totals) keeps the stored value.
          update: {
            userId: connection.userId,
            postJobResultId: item.resultId,
            ...Object.fromEntries(found.asked.map((key) => [key, found.counts[key]])),
            raw: numbers.raw,
            fetchedAt: now,
          },
        });
        result.updated += 1;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "P2002") {
          result.skippedOtherWorkspace += 1;
          logger.warn("[post-metrics] A post's numbers belong to another workspace; left alone", {
            platform: item.platform,
            resultId: item.resultId,
          });
          continue;
        }
        result.errors += 1;
        logger.error("[post-metrics] Couldn't save a post's numbers; carrying on", {
          platform: item.platform,
          resultId: item.resultId,
          ...errorFields(error),
        });
      }
    }
    if (batch.rateLimited && !limited.has(items[0].platform)) {
      limited.add(items[0].platform);
      logger.warn("[post-metrics] Platform is limiting requests; the rest are read tomorrow", {
        platform: items[0].platform,
      });
    }
  };

  const entries = [...groups.entries()];
  for (let index = 0; index < entries.length; index++) {
    const [key, items] = entries[index];
    const platform = items[0].platform;
    if (timeUp()) {
      result.left += entries.slice(index).reduce((sum, [, rest]) => sum + rest.length, 0);
      logger.info("[post-metrics] Time budget reached; the rest are read tomorrow", { left: result.left });
      break;
    }
    if (limited.has(platform)) {
      result.left += items.length;
      continue;
    }

    if (key.startsWith("none:")) {
      skip(items);
      continue;
    }

    let connection: SocialConnection | null;
    let token: string | null = null;
    try {
      connection = await prisma.socialConnection.findUnique({ where: { id: key } });
      if (
        connection &&
        !connection.needsReconnect &&
        connection.platform === platform &&
        items.every((item) => item.workspaceId === connection!.workspaceId)
      ) {
        token = await usableToken(connection);
      }
    } catch (error) {
      connection = null;
      logger.warn("[post-metrics] Couldn't get a usable token; skipping the connection", {
        connectionId: key,
        platform,
        ...errorFields(error),
      });
    }
    if (!connection || !token) {
      logger.warn("[post-metrics] Skipped a connection", { connectionId: key, platform });
      skip(items);
      continue;
    }

    const live = connection;
    const accessToken = token;
    /** One request (or, for Pinterest, one run of requests) for `chunk`, unless time or the platform's limit is up. */
    const read = async <B extends PostMetricsBatch>(
      chunk: SocialMetricEligibleResult[],
      fetch: () => Promise<B>,
    ): Promise<B | null> => {
      if (timeUp() || limited.has(platform)) {
        result.left += chunk.length;
        return null;
      }
      let batch: B;
      try {
        batch = await fetch();
      } catch (error) {
        // A fetcher is best effort and should not throw; if one does, the chunk
        // counts as errors and the run goes on.
        result.errors += chunk.length;
        stamped.push(...chunk.map((item) => item.resultId));
        logger.error("[post-metrics] Reading a connection's numbers failed; carrying on", {
          connectionId: key,
          platform,
          ...errorFields(error),
        });
        return null;
      }
      await record(chunk, batch, live);
      return batch;
    };

    if (platform === "instagram") {
      for (const chunk of chunks(items, INSTAGRAM_METRICS_IDS_PER_BATCH)) {
        await read(chunk, () =>
          fetchInstagramMediaMetricsBatch(
            chunk.map((item) => item.externalPostId),
            accessToken,
          ),
        );
      }
    } else if (platform === "facebook_page") {
      // Once Meta refuses the comment totals for a permission, the rest of this
      // connection's posts are asked without them (likes and shares still come).
      let withComments = true;
      const refusals: Record<string, number> = {};
      for (const chunk of chunks(items, FACEBOOK_METRICS_ITEMS_PER_BATCH)) {
        const refs = chunk.map((item) => ({ id: item.externalPostId, kind: facebookKind(item) }));
        const batch = await read(chunk, () => fetchFacebookPostMetricsBatch(refs, accessToken, { withComments }));
        if (!batch) continue;
        if (batch.commentsRefused) withComments = false;
        for (const [reason, count] of Object.entries(batch.refusals)) refusals[reason] = (refusals[reason] ?? 0) + count;
      }
      if (Object.keys(refusals).length > 0) {
        // One line per connection: reasons and counts only, no post, page or message.
        logger.warn("[post-metrics] Facebook refused some reads", { connectionId: key, platform, refusals });
      }
    } else if (platform === "linkedin") {
      const organizationUrn = linkedinOrganizationUrn(live);
      if (!organizationUrn) {
        logger.warn("[post-metrics] LinkedIn connection has no company page; skipped", { connectionId: key });
        skip(items);
        continue;
      }
      for (const chunk of chunks(items, LINKEDIN_URNS_PER_REQUEST)) {
        const urns = chunk.map((item) => item.externalPostId);
        await read(chunk, () => fetchLinkedInShareStatisticsBatch(organizationUrn, urns, accessToken));
      }
    } else {
      const today = items.slice(0, PINTEREST_PINS_PER_CONNECTION);
      result.left += items.length - today.length;
      const pins = today.map((item) => ({ id: item.externalPostId, publishedAt: item.publishedAt }));
      await read(today, () => fetchPinterestPinMetricsBatch(pins, accessToken, now, timeUp));
    }
  }

  if (stamped.length > 0) {
    // Raw UPDATE, as youtubeMetricsSync.ts: updateMany would bump @updatedAt,
    // which publish-health reads as "when the result finished" (and this
    // selector as the publish time).
    await prisma.$executeRaw`
      UPDATE "PostJobResult"
      SET "metricsCheckedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ANY(${stamped}::text[])`;
  }
  result.attempted = stamped.length;
  result.rateLimitedPlatforms = limited.size;
  return result;
}
