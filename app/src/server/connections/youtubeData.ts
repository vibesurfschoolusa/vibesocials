import { prisma } from "@/lib/db";

/**
 * YouTube API Services data handling (2026-11-09, for Google verification).
 *
 * The only YouTube data the app keeps is each published video's view, like and
 * comment counts (PostMetric rows, refreshed hourly by youtubePostMetricsSync).
 * The YouTube Developer Policies require stored statistics to be refreshed or
 * deleted within 30 days, and a user's YouTube data to be deleted when they
 * disconnect (https://developers.google.com/youtube/terms/developer-policies,
 * III.E.4). These two deletions are how the app keeps that promise; the privacy
 * policy states it.
 */

/** Statistics older than this are deleted: YouTube allows 30 days unrefreshed. */
export const YOUTUBE_METRICS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Deletes every stored YouTube statistic not refreshed in 30 days; returns the count. */
export async function purgeStaleYouTubeMetrics(now: Date = new Date()): Promise<number> {
  const result = await prisma.postMetric.deleteMany({
    where: {
      platform: "youtube",
      fetchedAt: { lt: new Date(now.getTime() - YOUTUBE_METRICS_MAX_AGE_MS) },
    },
  });
  return result.count;
}
