import {
  NO_COUNTS,
  countOf,
  emptyBatch,
  graphBatch,
  rawCounts,
  settleBatchEntry,
  type PostMetricsBatch,
} from "./facebookMetrics";

/**
 * Instagram post numbers (2026-11-10), read once a day by socialPostMetricsSync
 * with the Page token the app already holds. The IG Media node lists
 * `instagram_basic` and `pages_read_engagement` (both held) for Facebook Login
 * apps. Read: `like_count` ("Count of likes on the media"; omitted when the
 * owner hides like counts, so it stays null) and `comments_count`. Reach, views
 * and saves are insights, which need instagram_manage_insights: not asked for.
 *
 * The stored `externalPostId` is the media id media_publish answers
 * (instagramClient.ts), for a photo, a Reel and a carousel alike.
 *
 * The IG Media page documents one id per GET, so several ids go as one Graph
 * batch (at most 50, facebookMetrics.ts).
 * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media (read 2026-11-10)
 */

export const INSTAGRAM_METRICS_IDS_PER_BATCH = 50;

/** The numbers of up to INSTAGRAM_METRICS_IDS_PER_BATCH media. Best effort, never throws. */
export async function fetchInstagramMediaMetricsBatch(
  mediaIds: string[],
  accessToken: string,
): Promise<PostMetricsBatch> {
  const batch = emptyBatch();
  if (mediaIds.length === 0) return batch;

  const entries = await graphBatch(
    "instagram",
    mediaIds.map((id) => `${encodeURIComponent(id)}?fields=like_count,comments_count`),
    accessToken,
  );
  mediaIds.forEach((id, index) => {
    const entry = entries[index];
    if (entry.kind !== "ok") return settleBatchEntry(batch, id, entry);
    const media = entry.body as { like_count?: unknown; comments_count?: unknown } | null;
    const likes = countOf(media?.like_count);
    const comments = countOf(media?.comments_count);
    batch.byId.set(id, {
      counts: { ...NO_COUNTS, likes, comments },
      raw: rawCounts({ like_count: likes, comments_count: comments }),
      asked: ["likes", "comments"],
    });
  });
  return batch;
}
