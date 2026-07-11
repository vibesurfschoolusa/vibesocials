import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

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
