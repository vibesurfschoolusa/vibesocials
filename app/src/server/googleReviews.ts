import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

import { refreshConnectionToken } from "./platforms/connectionRefresh";
import { resolveGbpLocationName } from "./platforms/gbpLocation";
import { refreshGoogleToken } from "./platforms/googleTokens";

/**
 * Google Business Profile Review type
 */
export interface GoogleReview {
  name: string; // Full resource name (e.g., "accounts/.../locations/.../reviews/...")
  reviewId: string; // Extracted review ID
  reviewer: {
    profilePhotoUrl?: string;
    displayName: string;
    isAnonymous: boolean;
  };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
  };
}

/**
 * Refresh Google Business Profile access token.
 *
 * Thin wrapper over the shared `refreshGoogleToken` helper
 * (src/server/platforms/googleTokens.ts). The exported signature is preserved
 * because the reviews API routes import this by name. The helper updates ONLY
 * accessToken + expiresAt (never refreshToken) and throws
 * `GOOGLE_TOKEN_REFRESH_FAILED` on a non-2xx (previously
 * `GBP_REVIEWS_TOKEN_REFRESH_FAILED`); the reviews routes surface
 * `error.message`, not `.code`, so the code change is non-breaking.
 *
 * 2026-11-01 scale audit (jobs, token refresh): runs under the per-connection
 * lock (connectionRefresh.ts). If a publish, the health sweep or the metrics
 * sync refreshed the connection first, its row is returned and no second
 * refresh is sent. A connection that is gone or already flagged throws
 * `CONNECTION_GONE` / `RECONNECT_REQUIRED`, whose messages the routes surface.
 */
export async function refreshAccessToken(
  connection: SocialConnection
): Promise<SocialConnection> {
  return refreshConnectionToken(connection, (current) => refreshGoogleToken(current));
}

/**
 * Fetch reviews for a Google Business Profile location (first page only).
 *
 * `newestFirst` (2026-11-10, the new review email) asks for the largest page
 * (50) ordered `updateTime desc`, the only newest-first order Google offers
 * (rating, rating desc, updateTime desc). A review's updateTime is never before
 * its createTime, so every review created since the last daily check is on that
 * page unless more than 50 reviews were created or edited in between.
 */
export async function fetchReviews(
  accessToken: string,
  locationName: string,
  options: { newestFirst?: boolean } = {}
): Promise<GoogleReview[]> {
  console.log("[GBP Reviews] Fetching reviews", { locationName });

  // Resolve location name if it's a store code. The shared helper returns a
  // full "accounts/.../locations/..." resource name as-is and resolves a Store
  // code via the account/location listing.
  const resolvedLocationName = await resolveGbpLocationName(
    accessToken,
    locationName
  );

  // Use Google My Business API v4 to fetch reviews
  // API: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list
  const query = options.newestFirst
    ? `?pageSize=50&orderBy=${encodeURIComponent("updateTime desc")}`
    : "";
  const response = await fetchWithTimeout(
    `https://mybusiness.googleapis.com/v4/${resolvedLocationName}/reviews${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  await assertOk(response, {
    code: "GBP_REVIEWS_FETCH_FAILED",
    prefix: "Failed to fetch Google Business Profile reviews",
  });

  const data = (await response.json()) as {
    reviews?: Array<{
      name: string;
      reviewer: {
        profilePhotoUrl?: string;
        displayName: string;
        isAnonymous: boolean;
      };
      starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
      comment?: string;
      createTime: string;
      updateTime: string;
      reviewReply?: {
        comment: string;
        updateTime: string;
      };
    }>;
  };

  const reviews = (data.reviews || []).map((review) => ({
    ...review,
    // Extract review ID from name (e.g., "accounts/.../locations/.../reviews/ABC123")
    reviewId: review.name.split("/").pop() || "",
  }));

  console.log("[GBP Reviews] Fetched reviews successfully", {
    count: reviews.length,
  });

  return reviews;
}

/** The location id of `accounts/{a}/locations/{l}` or `locations/{l}`, or null. */
function locationIdOf(resourceName: string): string | null {
  const match = /(?:^|\/)locations\/([^/]+)$/.exec(resourceName);
  return match ? match[1] : null;
}

/**
 * The review link saved on a connection's metadata, or null. `newReviewUriFor`
 * names the location it was read for: a link saved before another location was
 * chosen belongs to the old one and counts as missing.
 */
export function savedNewReviewUri(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { locationName, newReviewUri, newReviewUriFor } = metadata as Record<string, unknown>;
  if (typeof newReviewUri !== "string" || newReviewUri === "") return null;
  if (typeof locationName !== "string" || locationName.trim() === "") return null;
  return newReviewUriFor === locationName.trim() ? newReviewUri : null;
}

/**
 * The link where a customer leaves a review for the location (2026-11-10, the
 * "Get more reviews" panel): Business Information API `metadata.newReviewUri`,
 * read with `readMask=metadata.newReviewUri` (scope business.manage, which the
 * connection holds). Null when Google gives none, or anything but an https link,
 * since it is shown as a link and drawn as a QR code. Throws on a refusal.
 */
export async function fetchNewReviewUri(
  accessToken: string,
  locationName: string
): Promise<string | null> {
  const resourceName = await resolveGbpLocationName(accessToken, locationName);
  const locationId = locationIdOf(resourceName);
  if (!locationId) return null;

  const response = await fetchWithTimeout(
    `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${encodeURIComponent(locationId)}?readMask=metadata.newReviewUri`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    15_000
  );
  await assertOk(response, {
    code: "GBP_REVIEW_LINK_FETCH_FAILED",
    prefix: "Failed to read the Google review link",
  });

  const body = (await response.json().catch(() => null)) as {
    metadata?: { newReviewUri?: unknown };
  } | null;
  const uri = body?.metadata?.newReviewUri;
  if (typeof uri !== "string" || uri.length > 2048) return null;
  try {
    return new URL(uri).protocol === "https:" ? uri : null;
  } catch {
    return null;
  }
}

/**
 * Reply to a Google Business Profile review
 */
export async function replyToReview(
  accessToken: string,
  reviewName: string,
  comment: string
): Promise<{ comment: string; updateTime: string }> {
  console.log("[GBP Reviews] Replying to review", { reviewName });

  // Use Google My Business API v4 to reply to review
  // API: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply
  // reviewName should be the full path: "accounts/.../locations/.../reviews/..."
  const response = await fetchWithTimeout(
    `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment,
      }),
    }
  );

  await assertOk(response, {
    code: "GBP_REVIEWS_REPLY_FAILED",
    prefix: "Failed to post Google Business Profile review reply",
  });

  const data = (await response.json()) as {
    comment: string;
    updateTime: string;
  };

  console.log("[GBP Reviews] Reply posted successfully");

  return data;
}
