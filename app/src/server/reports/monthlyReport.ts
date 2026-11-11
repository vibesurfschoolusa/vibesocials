import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  REPORT_NUMBER_KEYS,
  REPORT_POST_MAX,
  monthBounds,
  reportCaption,
  shiftMonth,
  summarizeListingMonth,
  summarizePostNumbers,
  type MonthlyReport,
  type ReportNumberKey,
  type ReportPost,
} from "@/lib/monthlyReport";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { platformPostUrl } from "@/lib/platformPostUrl";
import { METRIC_PLATFORMS } from "@/lib/postsDto";
import { storyPlatformsOf } from "@/lib/storyPlacement";

/**
 * Monthly report (18a): one workspace's month, built on request from what the
 * app already stores. Reads only; calls no platform.
 *
 * "Published at" is PostJobResult.updatedAt of a `success` result: the moment
 * the result finished, as publish-health reads it. Every later write to a
 * result that must not move it (the metrics syncs, the workspace heal) is a
 * raw UPDATE that leaves updatedAt alone.
 *
 * Every query carries the workspace id, and the result queries the month's
 * range. Rows are also checked against the workspace after they are read, so
 * nothing of another workspace can reach the object even if a filter slipped.
 */

function platformIndex(platform: Platform): number {
  return PLATFORM_ORDER.indexOf(platform);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function buildMonthlyReport(
  workspaceId: string,
  month: string,
  now: Date,
): Promise<MonthlyReport> {
  const { start, end } = monthBounds(month);
  const inMonth = { gte: start, lt: end };
  const isInMonth = (date: Date) => date >= start && date < end;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, logoUrl: true },
  });

  // Results per platform and failures per platform: one grouped count, served
  // by the [workspaceId, updatedAt] index publish-health uses.
  const groups = await prisma.postJobResult.groupBy({
    by: ["platform", "status"],
    // The result's own workspace id, as publish-health: no join over PostJob.
    where: {
      workspaceId,
      status: { in: ["success", "failed"] },
      updatedAt: inMonth,
    },
    _count: { _all: true },
  });
  const countsOf = (status: "success" | "failed") =>
    groups
      .filter((g) => g.status === status && g._count._all > 0)
      .sort((a, b) => platformIndex(a.platform) - platformIndex(b.platform))
      .map((g) => ({ platform: platformLabel(g.platform), count: g._count._all }));

  const postCount = await prisma.postJob.count({
    where: { workspaceId, results: { some: { workspaceId, status: "success", updatedAt: inMonth } } },
  });

  // The 200 most recently published posts. A post has at most one result per
  // platform, so the newest 200 x (number of platforms) successes always
  // contain them, and this read stays bounded however busy the month was.
  const recent = postCount
    ? await prisma.postJobResult.findMany({
        where: { workspaceId, status: "success", updatedAt: inMonth },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: REPORT_POST_MAX * PLATFORM_ORDER.length,
        select: { postJobId: true },
      })
    : [];
  const postIds = Array.from(new Set(recent.map((r) => r.postJobId))).slice(0, REPORT_POST_MAX);

  const jobs = postIds.length
    ? (
        await prisma.postJob.findMany({
          where: { id: { in: postIds }, workspaceId },
          select: {
            id: true,
            workspaceId: true,
            baseCaption: true,
            publishMetadata: true,
            // Null for a post without a file (2026-11-10): no picture, not a removed one.
            mediaItemId: true,
            mediaItem: {
              select: { baseCaption: true, storageLocation: true, mimeType: true, deletedAt: true },
            },
            // One per platform at most. Filtered to this month's successes below.
            results: {
              select: {
                platform: true,
                status: true,
                externalPostId: true,
                externalPostUrl: true,
                updatedAt: true,
              },
            },
          },
        })
      ).filter((row) => row.workspaceId === workspaceId)
    : [];

  const published = jobs.map((row) => ({
    row,
    results: row.results
      .filter((r) => r.status === "success" && isInMonth(r.updatedAt))
      .sort((a, b) => platformIndex(a.platform) - platformIndex(b.platform)),
  }));

  const photoCounts = jobs.length
    ? await prisma.postJobMedia.groupBy({
        by: ["postJobId"],
        where: { postJobId: { in: jobs.map((row) => row.id) } },
        _count: { _all: true },
      })
    : [];
  const photoCountById = new Map(photoCounts.map((row) => [row.postJobId, row._count._all]));

  // The numbers: one query for every listed result, joined as GET /api/posts
  // joins them, by (platform, externalPostId).
  const metricResults = published.flatMap(({ results }) =>
    results.filter((r) => METRIC_PLATFORMS.includes(r.platform) && r.externalPostId),
  );
  const metricRows = metricResults.length
    ? await prisma.postMetric.findMany({
        where: {
          workspaceId,
          platform: { in: Array.from(new Set(metricResults.map((r) => r.platform))) },
          externalPostId: { in: Array.from(new Set(metricResults.map((r) => r.externalPostId as string))) },
        },
        select: {
          workspaceId: true,
          platform: true,
          externalPostId: true,
          views: true,
          likes: true,
          comments: true,
          shares: true,
          clicks: true,
          saves: true,
        },
      })
    : [];
  const metricKey = (platform: string, id: string) => `${platform}:${id}`;
  const metricByPost = new Map(
    metricRows
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => [metricKey(row.platform, row.externalPostId), row]),
  );

  const posts: (ReportPost & { id: string })[] = published
    .filter(({ results }) => results.length > 0)
    .map(({ row, results }) => {
      const stories = storyPlatformsOf(row.publishMetadata) as Platform[];
      const media = row.mediaItem;
      return {
        id: row.id,
        publishedAt: new Date(Math.max(...results.map((r) => r.updatedAt.getTime()))).toISOString(),
        caption: reportCaption(row.baseCaption ?? media?.baseCaption ?? ""),
        // A file the retention sweep removed has no picture left to show.
        media: media && !media.deletedAt ? { url: media.storageLocation, mimeType: media.mimeType } : null,
        mediaCount: row.mediaItemId === null ? 0 : (photoCountById.get(row.id) ?? 1),
        platforms: results.map((r) => {
          const story = stories.includes(r.platform);
          const metric = r.externalPostId ? metricByPost.get(metricKey(r.platform, r.externalPostId)) : undefined;
          const numbers: Partial<Record<ReportNumberKey, number>> = {};
          for (const key of REPORT_NUMBER_KEYS) {
            const value = metric?.[key];
            if (typeof value === "number") numbers[key] = value;
          }
          return {
            platform: platformLabel(r.platform),
            story,
            // Exactly as the Activity card decides it (post-job-card.tsx).
            url: platformPostUrl(r.platform, r.externalPostId, r.externalPostUrl, { story }),
            numbers,
          };
        }),
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));

  return {
    month,
    workspaceName: workspace?.name ?? "",
    logoUrl: workspace?.logoUrl ?? null,
    inProgress: now.toISOString().slice(0, 7) === month,
    postCount,
    posts: posts.map((post) => ({
      publishedAt: post.publishedAt,
      caption: post.caption,
      media: post.media,
      mediaCount: post.mediaCount,
      platforms: post.platforms,
    })),
    totals: { resultsByPlatform: countsOf("success"), numbers: summarizePostNumbers(posts) },
    listing: await readListing(workspaceId, month, now),
    failed: countsOf("failed"),
  };
}

/**
 * The current listing's month, as GET /api/insights/listing-metrics finds the
 * listing: the Google connection's chosen locationName. Rows of a listing
 * chosen before never mix in. At most two months of rows (about 62).
 */
async function readListing(workspaceId: string, month: string, now: Date) {
  const connection = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform: "google_business_profile" } },
    select: { metadata: true },
  });
  const metadata =
    connection?.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
      ? (connection.metadata as Record<string, unknown>)
      : {};
  const locationName = nonEmptyString(metadata.locationName);
  if (!locationName) return null;

  const rows = await prisma.locationMetricDaily.findMany({
    where: {
      workspaceId,
      locationName,
      day: { gte: monthBounds(shiftMonth(month, -1)).start, lt: monthBounds(month).end },
    },
    select: {
      workspaceId: true,
      locationName: true,
      day: true,
      searchViews: true,
      mapsViews: true,
      calls: true,
      directionRequests: true,
      websiteClicks: true,
    },
  });
  return summarizeListingMonth(
    rows.filter((row) => row.workspaceId === workspaceId && row.locationName === locationName),
    month,
    now,
  );
}
