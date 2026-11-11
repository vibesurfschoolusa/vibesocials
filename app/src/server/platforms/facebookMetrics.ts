import type { Platform } from "@prisma/client";

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";

import { classifyRateLimit } from "./rateLimited";

/**
 * Facebook Page post numbers (2026-11-10), read once a day by
 * socialPostMetricsSync (server/jobs/socialMetricsSync.ts) with the Page token
 * the app already holds (pages_read_engagement; no new scope). Also home to the
 * pieces the Instagram fetcher shares: the counts shape, the batch result and
 * the Graph batch request.
 *
 * What the publish client stores as `externalPostId` (facebookPageClient.ts):
 *  - a photo: the PHOTO id (`/{page}/photos` answers `id` before `post_id`). A
 *    Photo node has no reactions or comments edge, so its post is found through
 *    its `page_story_id` field ("ID of the page story this corresponds to") and
 *    that post is read;
 *  - a video: the VIDEO id. The Video node has `/likes` and `/comments` edges
 *    but no shares, so likes and comments are read, shares stay null;
 *  - several photos: the feed post id (`<page>_<post>`), read directly.
 *  - Stories: the app does not publish them, so there is nothing to skip.
 *
 * Read on a post: `shares` ("Number of times the post has been shared", a
 * `{ count }` struct, absent when never shared), `reactions.summary(total_count)`
 * and `comments.summary(total_count)`, with `limit(0)` so no reactor or comment
 * is fetched, only the totals.
 *
 * Requests go as one Graph batch (POST with `batch=[...]`): "Batch requests are
 * limited to 50 requests per batch", each is counted separately against the
 * limits, and one failing request does not fail the others; a request that
 * timed out inside the batch comes back as `null`.
 *
 * References (read 2026-11-10):
 * https://developers.facebook.com/docs/graph-api/batch-requests
 * https://developers.facebook.com/docs/graph-api/reference/pagepost
 * https://developers.facebook.com/docs/graph-api/reference/photo/
 * https://developers.facebook.com/docs/graph-api/reference/video/
 * https://developers.facebook.com/docs/graph-api/reference/object/reactions
 * https://developers.facebook.com/docs/graph-api/reference/object/comments
 * https://developers.facebook.com/docs/graph-api/reference/object/likes
 */

/** Requests in one Graph batch: Meta's stated maximum. */
export const FACEBOOK_METRICS_ITEMS_PER_BATCH = 50;

/** One request a day per connection does not need the 30 s default. */
export const SOCIAL_METRICS_TIMEOUT_MS = 20_000;

/** The numbers a post can carry; a number the platform does not give is null. */
export interface SocialPostCounts {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
}

export interface FoundPostMetrics {
  counts: SocialPostCounts;
  /** Counts only, as the platform named them: stored as PostMetric.raw. */
  raw: Record<string, number>;
  /**
   * The numbers this read asked for. The sync's update writes only these, so a
   * read that left one out (Facebook without the comment totals) never blanks
   * a stored value; a number asked for and not given is written as null.
   */
  asked: Array<keyof SocialPostCounts>;
}

/**
 * What a batch fetch learned. Never thrown: every requested id ends up in
 * exactly one place, or in none, which means the platform no longer has it.
 */
export interface PostMetricsBatch {
  byId: Map<string, FoundPostMetrics>;
  /** Asked about, but the answer could not be used: tried again tomorrow. */
  failed: Set<string>;
  /** Not asked about (rate limited, or stopped for time): not stamped. */
  unchecked: Set<string>;
  /** The platform refused for rate or quota: ask it nothing more this run. */
  rateLimited: boolean;
}

export function emptyBatch(): PostMetricsBatch {
  return { byId: new Map(), failed: new Set(), unchecked: new Set(), rateLimited: false };
}

export const NO_COUNTS: SocialPostCounts = {
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
};

/** The column is a 32-bit Int: a larger count would fail the write. */
const MAX_INT = 2_147_483_647;

/**
 * A count as a whole number from 0 to the Int column's maximum, from a number
 * or a decimal string; anything else (missing, hidden, negative) is null,
 * never 0.
 */
export function countOf(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_INT ? n : null;
}

/** The counts that are numbers, for `raw`. */
export function rawCounts(entries: Record<string, number | null>): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== null) raw[key] = value;
  return raw;
}

export function hasAnyCount(counts: SocialPostCounts): boolean {
  return Object.values(counts).some((value) => value !== null);
}

/**
 * One answer of a Graph batch. A refusal carries `reason`, a label safe to log
 * (the Graph error code, or what went wrong): never a message, an id or a name.
 * `denied` marks a permission error.
 */
type BatchEntry =
  | { kind: "ok"; body: unknown }
  | { kind: "gone"; reason: string }
  | { kind: "failed"; reason: string; denied: boolean }
  | { kind: "limited" };

/**
 * Graph `error.code` 100 is read as "does not exist / cannot be loaded": a
 * deleted post. Meta also answers 100 for a missing permission or an unknown
 * field, so it is still counted among the refusals (with its subcode), and a
 * Page answering 100 for everything shows in the log.
 */
const GRAPH_NOT_FOUND_CODE = 100;

/** Graph permission errors: 10 ("does not have permission") and 200-299 (283: "requires the extended permission"). */
function isPermissionCode(code: number): boolean {
  return code === 10 || (code >= 200 && code < 300);
}

const failedEntry = (reason: string, denied = false): BatchEntry => ({ kind: "failed", reason, denied });

async function readEntry(platform: Platform, entry: unknown): Promise<BatchEntry> {
  const item = entry as { code?: unknown; body?: unknown } | null;
  // A request the batch did not finish comes back as null.
  if (!item) return failedEntry("no_answer");
  if (typeof item.code !== "number") return failedEntry("unreadable");
  let body: unknown = null;
  try {
    body = typeof item.body === "string" ? JSON.parse(item.body) : null;
  } catch {
    body = null;
  }
  if (item.code >= 200 && item.code < 300) {
    return body && typeof body === "object" ? { kind: "ok", body } : failedEntry("unreadable");
  }

  // classifyRateLimit reads a Response; one is built from the entry's own code and body.
  const limited = await classifyRateLimit(platform, new Response(JSON.stringify(body ?? {}), { status: item.code }));
  if (limited) return { kind: "limited" };
  const error = (body as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
  const code = error?.code;
  if (typeof code !== "number" || !Number.isInteger(code)) return failedEntry("unreadable");
  if (code === GRAPH_NOT_FOUND_CODE) {
    const subcode = error?.error_subcode;
    return { kind: "gone", reason: Number.isInteger(subcode) ? `${code}/${subcode}` : String(code) };
  }
  return failedEntry(String(code), isPermissionCode(code));
}

/**
 * One Graph batch of GETs. Resolves to one entry per request, in order, or to
 * "failed" / "limited" for all of them when the batch itself was refused. Never
 * throws. The token goes in the form body, never in the URL; nothing logged
 * names a token or a post.
 */
export async function graphBatch(
  platform: Platform,
  relativeUrls: string[],
  accessToken: string,
): Promise<BatchEntry[]> {
  const all = (entry: BatchEntry): BatchEntry[] => relativeUrls.map(() => entry);
  try {
    const response = await fetchWithTimeout(
      `${META_GRAPH_BASE_URL}/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          batch: JSON.stringify(relativeUrls.map((url) => ({ method: "GET", relative_url: url }))),
          include_headers: "false",
          access_token: accessToken,
        }),
      },
      SOCIAL_METRICS_TIMEOUT_MS,
    );
    if (await classifyRateLimit(platform, response)) return all({ kind: "limited" });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      console.error("[PostMetrics] Graph batch refused", { platform, status: response.status });
      return all(failedEntry(`http_${response.status}`));
    }
    const entries = (await response.json()) as unknown;
    if (!Array.isArray(entries)) return all(failedEntry("unreadable"));
    return Promise.all(relativeUrls.map((_, index) => readEntry(platform, entries[index])));
  } catch (error) {
    console.error("[PostMetrics] Graph batch failed", {
      platform,
      error: error instanceof Error ? error.name : "unknown",
      code: (error as { code?: unknown } | null)?.code,
    });
    return all(failedEntry("request_failed"));
  }
}

/** Sort one id by what its entry said; "ok" is handled by the caller. */
function settle(batch: PostMetricsBatch, id: string, entry: BatchEntry): void {
  if (entry.kind === "failed") batch.failed.add(id);
  else if (entry.kind === "limited") {
    batch.rateLimited = true;
    batch.unchecked.add(id);
  }
}

export type FacebookPostKind = "post" | "photo" | "video";

export interface FacebookPostRef {
  /** The stored `externalPostId`. */
  id: string;
  kind: FacebookPostKind;
}

export interface FacebookPostMetricsBatch extends PostMetricsBatch {
  /** Refused reads by reason (Graph error code, `no_answer`, `http_<status>`...): counts only, for the log. */
  refusals: Record<string, number>;
  /**
   * A read refused for a permission succeeded without the comment totals: the
   * caller asks without them for the rest of the connection's run.
   */
  commentsRefused: boolean;
}

const LIKES = "likes.summary(total_count).limit(0)";
const REACTIONS = "reactions.summary(total_count).limit(0)";
const COMMENTS = "comments.summary(total_count).limit(0)";

function fieldsFor(video: boolean, withComments: boolean): string {
  const fields = video ? [LIKES] : ["shares", REACTIONS];
  if (withComments) fields.push(COMMENTS);
  return fields.join(",");
}

const totalOf = (edge: unknown) => countOf((edge as { summary?: { total_count?: unknown } } | null)?.summary?.total_count);

/** A post's (or a video's) numbers; an edge not asked for or not sent stays null. */
function readCounts(body: unknown, video: boolean, withComments: boolean): FoundPostMetrics {
  const node = body as { reactions?: unknown; likes?: unknown; comments?: unknown; shares?: { count?: unknown } } | null;
  const comments = withComments ? totalOf(node?.comments) : null;
  const askedComments: Array<keyof SocialPostCounts> = withComments ? ["comments"] : [];
  if (video) {
    const likes = totalOf(node?.likes);
    return {
      counts: { ...NO_COUNTS, likes, comments },
      raw: rawCounts({ likes, comments }),
      asked: ["likes", ...askedComments],
    };
  }
  const reactions = totalOf(node?.reactions);
  const shares = countOf(node?.shares?.count);
  return {
    counts: { ...NO_COUNTS, likes: reactions, comments, shares },
    raw: rawCounts({ reactions, comments, shares }),
    asked: ["likes", "shares", ...askedComments],
  };
}

/**
 * The numbers of up to FACEBOOK_METRICS_ITEMS_PER_BATCH posts of one Page:
 * one batch to find the photos' posts (when there are photos) and one to read
 * them all. When a read is refused for a permission while the comment totals
 * were asked for, those posts are read once more without them: likes and
 * shares are kept and comments stay null (whether Meta wants
 * pages_read_user_content for the totals is not stated; the app does not hold
 * it). `withComments: false` leaves them out from the start. Best effort,
 * never throws.
 */
export async function fetchFacebookPostMetricsBatch(
  refs: FacebookPostRef[],
  accessToken: string,
  opts: { withComments?: boolean } = {},
): Promise<FacebookPostMetricsBatch> {
  const withComments = opts.withComments ?? true;
  const batch: FacebookPostMetricsBatch = { ...emptyBatch(), refusals: {}, commentsRefused: false };
  if (refs.length === 0) return batch;

  const note = (entry: BatchEntry) => {
    if (entry.kind === "failed" || entry.kind === "gone") {
      batch.refusals[entry.reason] = (batch.refusals[entry.reason] ?? 0) + 1;
    }
  };

  // The node to read for each stored id.
  const targets = new Map<string, { node: string; video: boolean }>();
  const photos = refs.filter((ref) => ref.kind === "photo");
  if (photos.length > 0) {
    const entries = await graphBatch(
      "facebook_page",
      photos.map((photo) => `${encodeURIComponent(photo.id)}?fields=page_story_id`),
      accessToken,
    );
    photos.forEach((photo, index) => {
      const entry = entries[index];
      note(entry);
      if (entry.kind !== "ok") return settle(batch, photo.id, entry);
      const storyId = (entry.body as { page_story_id?: unknown } | null)?.page_story_id;
      // No page_story_id ("may not be on all photos"): nothing to read.
      if (typeof storyId === "string" && storyId !== "") targets.set(photo.id, { node: storyId, video: false });
    });
    if (batch.rateLimited) {
      // Nothing more is asked this run: every post not read yet is unchecked,
      // including photos whose post was found.
      for (const ref of refs) if (!batch.failed.has(ref.id)) batch.unchecked.add(ref.id);
      return batch;
    }
  }
  for (const ref of refs) {
    if (ref.kind !== "photo") targets.set(ref.id, { node: ref.id, video: ref.kind === "video" });
  }
  if (targets.size === 0) return batch;

  const read = (ids: string[], comments: boolean) =>
    graphBatch(
      "facebook_page",
      ids.map((id) => {
        const target = targets.get(id)!;
        return `${encodeURIComponent(target.node)}?fields=${fieldsFor(target.video, comments)}`;
      }),
      accessToken,
    );

  const ids = [...targets.keys()];
  const entries = await read(ids, withComments);
  const denied: string[] = [];
  ids.forEach((id, index) => {
    const entry = entries[index];
    note(entry);
    if (entry.kind === "ok") batch.byId.set(id, readCounts(entry.body, targets.get(id)!.video, withComments));
    else if (withComments && entry.kind === "failed" && entry.denied) denied.push(id);
    else settle(batch, id, entry);
  });
  if (denied.length === 0) return batch;
  if (batch.rateLimited) {
    for (const id of denied) batch.unchecked.add(id);
    return batch;
  }

  const again = await read(denied, false);
  denied.forEach((id, index) => {
    const entry = again[index];
    note(entry);
    if (entry.kind === "ok") {
      batch.byId.set(id, readCounts(entry.body, targets.get(id)!.video, false));
      batch.commentsRefused = true;
    } else settle(batch, id, entry);
  });
  return batch;
}

/** For the Instagram fetcher: the same entry sorting. */
export { settle as settleBatchEntry };
