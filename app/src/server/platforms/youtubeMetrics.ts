import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { classifyRateLimit } from "@/server/platforms/rateLimited";

/**
 * Roadmap Phase 8 (analytics — post performance, §7.3). YouTube-only metric
 * read path, isolated from the publish client on purpose.
 *
 * Reads per-video engagement from the YouTube Data API v3
 * `videos.list?part=statistics&id=<videoId>` endpoint — which the app's EXISTING
 * YouTube OAuth scope already permits, so it requires NO new scope and NO owner
 * reconnect (the full YouTube Analytics API, which would, is explicitly avoided
 * in v1). `shareCount` is not exposed by this endpoint, so shares are stored as
 * `null` upstream (see the sync cron), never fabricated as 0.
 */

/** Parsed, display-ready counts. `null` = the count is missing/hidden/unparseable (never coerced to 0). */
export interface YouTubeStatistics {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

const EMPTY_STATISTICS: YouTubeStatistics = {
  views: null,
  likes: null,
  comments: null,
};

/**
 * Coerce a YouTube statistics count to a number.
 *
 * The API returns counts as decimal STRINGS (e.g. `"12345"`). A missing key
 * (e.g. `likeCount` when the creator has hidden likes) or any non-numeric /
 * empty value yields `null` — deliberately NOT `0`, so "hidden" is
 * distinguishable from "zero" downstream.
 */
function coerceCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * PURE parser for a `videos.list?part=statistics` response body.
 *
 * Reads `items[0].statistics` and coerces `viewCount` / `likeCount` /
 * `commentCount` via {@link coerceCount}. Defensive at every hop: a missing item
 * (empty `items` — e.g. the video was deleted or is inaccessible), a missing
 * `statistics` object, a malformed payload, or a hidden like count all resolve
 * to `null` fields rather than throwing. Never touches the network.
 */
export function parseYouTubeStatistics(apiResponse: unknown): YouTubeStatistics {
  if (!apiResponse || typeof apiResponse !== "object") {
    return { ...EMPTY_STATISTICS };
  }
  const items = (apiResponse as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ...EMPTY_STATISTICS };
  }
  const first = items[0];
  if (!first || typeof first !== "object") {
    return { ...EMPTY_STATISTICS };
  }
  const statistics = (first as { statistics?: unknown }).statistics;
  if (!statistics || typeof statistics !== "object") {
    return { ...EMPTY_STATISTICS };
  }
  const stats = statistics as Record<string, unknown>;
  return {
    views: coerceCount(stats.viewCount),
    likes: coerceCount(stats.likeCount),
    comments: coerceCount(stats.commentCount),
  };
}

/**
 * True when at least one count parsed to a real number (review Minor #2/#5).
 * The cron uses this to skip the upsert on an all-`null` parse — a 200 whose
 * `items` is present but whose `statistics` object is missing/empty would
 * otherwise WIPE a previously-good snapshot to null. `found` (non-empty items)
 * isn't enough; this guards on actual data.
 */
export function hasAnyStatistic(stats: YouTubeStatistics): boolean {
  return stats.views !== null || stats.likes !== null || stats.comments !== null;
}

/**
 * Result of {@link fetchYouTubeVideoStatistics}. Best-effort: this NEVER throws
 * to the caller.
 *
 * - `ok: true, found: true`  — the video exists; `stats` holds its counts.
 * - `ok: true, found: false` — HTTP 200 but the video is gone/inaccessible
 *   (empty `items`). The caller MUST NOT overwrite a prior good snapshot with
 *   the all-`null` `stats` in this case — leave the last-known metric intact.
 * - `ok: false`              — HTTP, network, or JSON-parse failure. `code` /
 *   `error` are sanitized (no upstream body); the caller skips the item.
 */
export type YouTubeMetricsFetchResult =
  | { ok: true; found: boolean; stats: YouTubeStatistics; raw: unknown }
  | { ok: false; code: string; error: string };

const YOUTUBE_VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

/**
 * Fetch a single video's statistics with an already-authenticated Google access
 * token. Uses the EXISTING YouTube scope (no Analytics scope). Best-effort — any
 * failure returns a typed `{ ok: false }` rather than throwing, so one bad video
 * can never sink a batch sync. Token acquisition/refresh is the caller's job
 * (the cron reuses `refreshGoogleToken`); this function only reads.
 */
export async function fetchYouTubeVideoStatistics(
  videoId: string,
  accessToken: string,
): Promise<YouTubeMetricsFetchResult> {
  try {
    const url = `${YOUTUBE_VIDEOS_ENDPOINT}?part=statistics&id=${encodeURIComponent(videoId)}`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      // Read the body for SERVER logs only; never surface it (SEC — could echo
      // request context). Return a sanitized, typed failure.
      const body = await response.text().catch(() => "<unable to read response body>");
      console.error("[YouTubeMetrics] videos.list returned non-2xx", {
        videoId,
        status: response.status,
        body,
      });
      return {
        ok: false,
        code: "YOUTUBE_METRICS_HTTP_ERROR",
        error: `videos.list failed (status ${response.status})`,
      };
    }

    const json = (await response.json()) as unknown;
    const items = (json as { items?: unknown }).items;
    const found = Array.isArray(items) && items.length > 0;
    const stats = parseYouTubeStatistics(json);
    return { ok: true, found, stats, raw: json };
  } catch (error: unknown) {
    console.error("[YouTubeMetrics] videos.list threw", { videoId, error });
    return {
      ok: false,
      code: "YOUTUBE_METRICS_FETCH_ERROR",
      error: error instanceof Error ? error.message : "Unknown error fetching YouTube statistics",
    };
  }
}

/**
 * Result of {@link fetchYouTubeVideoStatisticsBatch}. Best-effort: NEVER throws.
 *
 * - `ok: true`  - the call succeeded. `byId` holds every video YouTube returned;
 *   a requested id that is ABSENT from it is "not found" (deleted, private or
 *   otherwise inaccessible) and the caller must leave its last-known metric
 *   intact. A present video may still carry all-`null` stats (see
 *   {@link hasAnyStatistic}). `raw` is that video's `items[]` entry.
 * - `ok: false` - HTTP, network or JSON-parse failure; `code` is sanitized (no
 *   upstream body). `quotaExceeded` is true when YouTube refused the call for
 *   quota or rate (HTTP 403 quotaExceeded / dailyLimitExceeded / rateLimitExceeded
 *   / userRateLimitExceeded, or 429): every further call in this run would be
 *   refused too, so the caller stops the run.
 */
export type YouTubeMetricsBatchResult =
  | { ok: true; byId: Map<string, { stats: YouTubeStatistics; raw: unknown }> }
  | { ok: false; code: string; quotaExceeded: boolean };

/**
 * 2026-11-01 scale audit (jobs, YouTube metrics): fetch the statistics of many
 * videos in ONE `videos.list?part=statistics&id=a,b,c` call. The call costs 1
 * quota unit however many ids it carries (https://developers.google.com/youtube/v3/determine_quota_cost),
 * which is why the hourly sync batches instead of calling once per video. The
 * caller keeps `videoIds` within YOUTUBE_STATS_IDS_PER_CALL (metricsScanner.ts);
 * nothing is requested for an empty list. Same auth and best-effort contract as
 * {@link fetchYouTubeVideoStatistics}.
 */
export async function fetchYouTubeVideoStatisticsBatch(
  videoIds: string[],
  accessToken: string,
): Promise<YouTubeMetricsBatchResult> {
  if (videoIds.length === 0) {
    return { ok: true, byId: new Map() };
  }

  try {
    const url = `${YOUTUBE_VIDEOS_ENDPOINT}?part=statistics&id=${videoIds.map(encodeURIComponent).join(",")}`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      // classifyRateLimit reads a CLONE of the body, so it is still readable here.
      const limited = await classifyRateLimit("youtube", response);
      // Read the body for SERVER logs only; never surface it (SEC).
      const body = await response.text().catch(() => "<unable to read response body>");
      console.error("[YouTubeMetrics] videos.list (batch) returned non-2xx", {
        videoCount: videoIds.length,
        status: response.status,
        body,
      });
      return limited
        ? { ok: false, code: "YOUTUBE_METRICS_QUOTA_EXCEEDED", quotaExceeded: true }
        : { ok: false, code: "YOUTUBE_METRICS_HTTP_ERROR", quotaExceeded: false };
    }

    const json = (await response.json()) as unknown;
    const items = (json as { items?: unknown } | null)?.items;
    const byId = new Map<string, { stats: YouTubeStatistics; raw: unknown }>();
    if (Array.isArray(items)) {
      for (const item of items) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "string") {
          continue;
        }
        byId.set(id, { stats: parseYouTubeStatistics({ items: [item] }), raw: item });
      }
    }
    return { ok: true, byId };
  } catch (error: unknown) {
    console.error("[YouTubeMetrics] videos.list (batch) threw", {
      videoCount: videoIds.length,
      error,
    });
    return { ok: false, code: "YOUTUBE_METRICS_FETCH_ERROR", quotaExceeded: false };
  }
}
