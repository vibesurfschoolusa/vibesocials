import type { SocialConnection } from "@prisma/client";

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
 * Refresh Google Business Profile access token
 */
export async function refreshAccessToken(
  connection: SocialConnection
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    throw new Error("No refresh token available for Google Business Profile");
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Google Business Profile OAuth credentials");
  }

  console.log("[GBP Reviews] Refreshing access token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unable to read error");
    console.error("[GBP Reviews] Token refresh failed", {
      status: response.status,
      errorBody,
    });
    throw new Error("Failed to refresh Google Business Profile access token");
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  // Update connection in database
  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: tokenData.access_token,
      expiresAt,
    },
  });

  console.log("[GBP Reviews] Access token refreshed successfully");

  return updated;
}

/**
 * Fetch reviews for a Google Business Profile location
 */
export async function fetchReviews(
  accessToken: string,
  locationName: string
): Promise<GoogleReview[]> {
  console.log("[GBP Reviews] Fetching reviews", { locationName });

  // Resolve location name if it's a store code
  const resolvedLocationName = await resolveLocationName(
    accessToken,
    locationName
  );

  // Use Google My Business API v4 to fetch reviews
  // API: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list
  const response = await fetch(
    `https://mybusiness.googleapis.com/v4/${resolvedLocationName}/reviews`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unable to read error");
    console.error("[GBP Reviews] Fetch reviews failed", {
      status: response.status,
      errorBody,
    });
    throw new Error(`Failed to fetch reviews: ${errorBody}`);
  }

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
  const response = await fetch(
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

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unable to read error");
    console.error("[GBP Reviews] Reply failed", {
      status: response.status,
      errorBody,
    });
    throw new Error(`Failed to post reply: ${errorBody}`);
  }

  const data = (await response.json()) as {
    comment: string;
    updateTime: string;
  };

  console.log("[GBP Reviews] Reply posted successfully");

  return data;
}

/**
 * Resolve location name (handle both full resource names and store codes)
 */
async function resolveLocationName(
  accessToken: string,
  locationName: string
): Promise<string> {
  const trimmed = locationName.trim();

  // If it's already a full resource name (accounts/.../locations/...), return it
  if (trimmed.startsWith("accounts/")) {
    return trimmed;
  }

  // Otherwise, resolve it from store code using the existing logic
  return resolveLocationNameFromStoreCode(accessToken, trimmed);
}

/**
 * Resolve location name from store code
 * (Copied from googleBusinessProfileClient.ts)
 */
async function resolveLocationNameFromStoreCode(
  accessToken: string,
  identifier: string
): Promise<string> {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  } as const;

  const accountManagementBase =
    "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase =
    "https://mybusinessbusinessinformation.googleapis.com/v1";

  // 1. List all accounts the user has access to.
  const accountsRes = await fetch(`${accountManagementBase}/accounts`, {
    headers: authHeaders,
  });

  if (!accountsRes.ok) {
    console.error("[GBP Reviews] accounts.list failed while resolving store code", {
      status: accountsRes.status,
      statusText: accountsRes.statusText,
    });
    throw new Error(
      "Failed to list Google Business Profile accounts while resolving location."
    );
  }

  const accountsJson = (await accountsRes.json()) as {
    accounts?: { name?: string }[];
  };

  const accounts = accountsJson.accounts ?? [];
  const candidates: string[] = [];

  // 2. For each account, search locations by storeCode.
  for (const account of accounts) {
    const accountName = account.name;
    if (!accountName) continue;

    const url = new URL(`${businessInfoBase}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,storeCode,title");
    url.searchParams.set("filter", `storeCode="${identifier}"`);

    const locationsRes = await fetch(url.toString(), {
      headers: authHeaders,
    });

    if (!locationsRes.ok) {
      console.error("[GBP Reviews] accounts.locations.list failed for account", {
        accountName,
        status: locationsRes.status,
        statusText: locationsRes.statusText,
      });
      continue;
    }

    const locationsJson = (await locationsRes.json()) as {
      locations?: { name?: string; storeCode?: string }[];
    };

    const locations = locationsJson.locations ?? [];
    for (const loc of locations) {
      if (!loc.name) continue;
      if (loc.storeCode !== identifier) continue;

      const locationId = loc.name.startsWith("locations/")
        ? loc.name.slice("locations/".length)
        : loc.name;
      const [, accountId] = accountName.split("/");
      if (!accountId) continue;

      candidates.push(`accounts/${accountId}/locations/${locationId}`);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      "Could not find a Google Business Profile location for the given store code."
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      "Store code matched multiple Google Business Profile locations. Please specify a more precise identifier."
    );
  }

  return candidates[0];
}
