import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

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
 */
export async function refreshAccessToken(
  connection: SocialConnection
): Promise<SocialConnection> {
  return refreshGoogleToken(connection);
}

/**
 * Fetch reviews for a Google Business Profile location
 */
export async function fetchReviews(
  accessToken: string,
  locationName: string
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
  const response = await fetchWithTimeout(
    `https://mybusiness.googleapis.com/v4/${resolvedLocationName}/reviews`,
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
