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
 *   &organizationalEntity={organization URN}&shares=List(...) (or ugcPosts[0]=...&ugcPosts[1]=...)
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

/**
 * Each URN encoded. shares as a Rest.li 2.0 List( , ), ugcPosts indexed
 * (ugcPosts[0]=...&ugcPosts[1]=...), each as the share-statistics page shows
 * it (li-lms-2026-10, read 2026-11-17; R41 platform L1).
 */
function statisticsUrl(organizationUrn: string, param: (typeof KINDS)[number]["param"], urns: string[]): string {
  const list =
    param === "shares"
      ? `&shares=List(${urns.map(encodeURIComponent).join(",")})`
      : urns.map((urn, index) => `&${param}[${index}]=${encodeURIComponent(urn)}`).join("");
  return `${STATISTICS_URL}?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}${list}`;
}

/** A code or field path as LinkedIn sends it; anything else (text, a URN) is left out. */
function plainLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(value) ? value : null;
}

/**
 * R41 platform L1: what a refusal's log line may carry from LinkedIn's error
 * body: its codes and the failing field paths. Never its message or
 * descriptions, which can name a post (socialMetricsSync.ts: logs never do).
 */
async function refusalFields(response: Response) {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not LinkedIn's JSON (a gateway page): no codes to log.
  }
  const serviceErrorCode = body?.serviceErrorCode;
  const details = body?.errorDetails as { inputErrors?: unknown } | undefined;
  const inputErrors = Array.isArray(details?.inputErrors) ? details.inputErrors : [];
  return {
    serviceErrorCode: Number.isInteger(serviceErrorCode) ? (serviceErrorCode as number) : null,
    code: plainLabel(body?.code),
    inputErrors: inputErrors.slice(0, 5).map((item) => {
      const entry = item as { code?: unknown; input?: { inputPath?: { fieldPath?: unknown } } } | null;
      return { code: plainLabel(entry?.code), fieldPath: plainLabel(entry?.input?.inputPath?.fieldPath) };
    }),
  };
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
        // A 4xx is this request's own (a post LinkedIn won't report on): a
        // warning. A 5xx is LinkedIn's trouble: an error.
        const log = response.status < 500 ? console.warn : console.error;
        log("[PostMetrics] LinkedIn share statistics refused", {
          param: kind.param,
          urnCount: urns.length,
          status: response.status,
          ...(await refusalFields(response)),
        });
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
        param: kind.param,
        urnCount: urns.length,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
      });
      for (const urn of urns) batch.failed.add(urn);
    }
  }
  return batch;
}
