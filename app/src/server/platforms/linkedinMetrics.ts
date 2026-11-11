import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { LINKEDIN_REST_BASE_URL, linkedinRestHeaders } from "@/lib/linkedinApi";

import {
  NO_COUNTS,
  SOCIAL_METRICS_TIMEOUT_MS,
  countOf,
  emptyBatch,
  rawCounts,
  type PostMetricsBatch,
} from "./facebookMetrics";
import { classifyRateLimit } from "./rateLimited";

/**
 * LinkedIn company page post numbers (2026-11-10), read once a day by
 * socialPostMetricsSync with the member token the app already holds.
 *
 * GET /rest/organizationalEntityShareStatistics?q=organizationalEntity
 *   &organizationalEntity={organization URN}&shares=List(...) (or ugcPosts=List(...))
 * "Permission: rw_organization_admin - Manage organizations pages and retrieve
 * reporting data", held (oauthScopes.ts). No r_organization_social endpoint is used.
 * Lifetime statistics (no timeIntervals; "Time-bound statistics is not supported
 * for specific share queries"), organic only, "within the past 12 months".
 *
 * Read from `totalShareStatistics`: impressionCount -> views, clickCount ->
 * clicks, likeCount -> likes, commentCount -> comments, shareCount -> shares.
 * The page: "Shares with no actions or impressions are not included in the list
 * of elements ... can be assumed to have counts of 0". The sync stores nothing
 * for such a post rather than writing zeros it was not sent; a deleted post
 * looks the same.
 *
 * The stored `externalPostId` is the Posts API's `x-restli-id`: `urn:li:share:...`
 * or `urn:li:ugcPost:...` (linkedinClient.ts). The page shows each kind in its
 * own request and does not say they may be mixed, so they go in two. It states no
 * limit on the number of URNs; LINKEDIN_URNS_PER_REQUEST keeps the URL short.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics (read 2026-11-10, li-lms-2026-10)
 */

export const LINKEDIN_URNS_PER_REQUEST = 20;

const STATISTICS_URL = `${LINKEDIN_REST_BASE_URL}/organizationalEntityShareStatistics`;

const KINDS = [
  { param: "shares", prefix: "urn:li:share:", field: "share" },
  { param: "ugcPosts", prefix: "urn:li:ugcPost:", field: "ugcPost" },
] as const;

/** Rest.li 2.0 list: each URN encoded, the List( , ) syntax left as is. */
function statisticsUrl(organizationUrn: string, param: string, urns: string[]): string {
  return (
    `${STATISTICS_URL}?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}` +
    `&${param}=List(${urns.map(encodeURIComponent).join(",")})`
  );
}

/**
 * The lifetime numbers of up to LINKEDIN_URNS_PER_REQUEST posts of the page
 * `organizationUrn`. Best effort, never throws.
 */
export async function fetchLinkedInShareStatisticsBatch(
  organizationUrn: string,
  postUrns: string[],
  accessToken: string,
): Promise<PostMetricsBatch> {
  const batch = emptyBatch();

  for (const kind of KINDS) {
    const urns = postUrns.filter((urn) => urn.startsWith(kind.prefix));
    if (urns.length === 0) continue;
    if (batch.rateLimited) {
      for (const urn of urns) batch.unchecked.add(urn);
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        statisticsUrl(organizationUrn, kind.param, urns),
        { headers: linkedinRestHeaders(accessToken) },
        SOCIAL_METRICS_TIMEOUT_MS,
      );
      if (await classifyRateLimit("linkedin", response)) {
        batch.rateLimited = true;
        for (const urn of urns) batch.unchecked.add(urn);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        console.error("[PostMetrics] LinkedIn share statistics refused", { status: response.status });
        for (const urn of urns) batch.failed.add(urn);
        continue;
      }
      const body = (await response.json()) as { elements?: unknown } | null;
      const wanted = new Set(urns);
      for (const element of Array.isArray(body?.elements) ? body.elements : []) {
        const item = element as Record<string, unknown> | null;
        const urn = item?.[kind.field];
        if (typeof urn !== "string" || !wanted.has(urn)) continue;
        const stats = (item?.totalShareStatistics ?? null) as Record<string, unknown> | null;
        const numbers = {
          impressionCount: countOf(stats?.impressionCount),
          clickCount: countOf(stats?.clickCount),
          likeCount: countOf(stats?.likeCount),
          commentCount: countOf(stats?.commentCount),
          shareCount: countOf(stats?.shareCount),
        };
        batch.byId.set(urn, {
          counts: {
            ...NO_COUNTS,
            views: numbers.impressionCount,
            clicks: numbers.clickCount,
            likes: numbers.likeCount,
            comments: numbers.commentCount,
            shares: numbers.shareCount,
          },
          raw: rawCounts(numbers),
          asked: ["views", "clicks", "likes", "comments", "shares"],
        });
      }
    } catch (error) {
      console.error("[PostMetrics] LinkedIn share statistics failed", {
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
      });
      for (const urn of urns) batch.failed.add(urn);
    }
  }
  return batch;
}
