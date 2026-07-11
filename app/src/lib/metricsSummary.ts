import type { PostJobDTO } from "@/lib/postsDto";

/**
 * Roadmap Phase 8 (analytics — post performance). Pure aggregate over the post
 * jobs the dashboard already loads, so the summary needs NO extra endpoint.
 * YouTube-only in v1 (the only platform with fetched metrics).
 */
export interface YouTubeMetricsSummary {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  /** Distinct YouTube videos with a fetched metric (drives "across N videos"). */
  trackedVideos: number;
}

/**
 * Sum views/likes/comments across the user's YouTube posts that have a fetched
 * metric. Deduped by `externalPostId` (the video id) so the same video counted
 * in two results is never summed twice. A `null` count (not yet fetched, or a
 * hidden like count) contributes 0 to the sum — you cannot total an unknown —
 * while `trackedVideos` counts only videos that actually have a metric row, so
 * "0 views across 0 videos" cleanly means "no data yet".
 */
export function summarizeYouTubeMetrics(jobs: PostJobDTO[]): YouTubeMetricsSummary {
  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  const seen = new Set<string>();

  for (const job of jobs) {
    for (const result of job.results) {
      if (result.platform !== "youtube" || !result.metric || !result.externalPostId) {
        continue;
      }
      if (seen.has(result.externalPostId)) {
        continue;
      }
      seen.add(result.externalPostId);
      totalViews += result.metric.views ?? 0;
      totalLikes += result.metric.likes ?? 0;
      totalComments += result.metric.comments ?? 0;
    }
  }

  return {
    totalViews,
    totalLikes,
    totalComments,
    trackedVideos: seen.size,
  };
}
