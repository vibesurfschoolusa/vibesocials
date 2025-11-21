import type { SocialConnection } from "@prisma/client";

import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Google Business Profile client (photos that appear on Google Maps)
//
// This client uses the Google Business Profile API to create media for a
// specific business location (locationName in SocialConnection.metadata) so
// photos appear on Google Maps.

async function refreshAccessToken(connection: SocialConnection): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    throw new Error("No refresh token available for Google Business Profile");
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Google Business Profile OAuth credentials");
  }

  console.log("[GBP] Refreshing access token");

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
    console.error("[GBP] Token refresh failed", {
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

  console.log("[GBP] Access token refreshed successfully");

  return updated;
}

export const googleBusinessProfileClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem } = ctx;

    // Check if token needs refresh
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[GBP] Access token expired, refreshing...");
      socialConnection = await refreshAccessToken(socialConnection);
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Google Business Profile");
      (error as any).code = "GBP_NO_ACCESS_TOKEN";
      throw error;
    }

    // Google Business Profile primarily supports photos
    if (mediaItem.mimeType && !mediaItem.mimeType.startsWith("image/")) {
      console.warn("[GBP] Attempting to upload non-image media", {
        mimeType: mediaItem.mimeType,
        originalFilename: mediaItem.originalFilename,
      });
    }

    const { locationName } = await ensureLocationName(socialConnection, accessToken);

    console.log("[GBP] Starting media creation", {
      locationName,
      storageLocation: mediaItem.storageLocation,
      mimeType: mediaItem.mimeType,
    });

    // Use Google My Business API v4 to create media with the Vercel Blob public URL
    const isPhoto = mediaItem.mimeType?.startsWith("image/") ?? true;
    const mediaFormat = isPhoto ? "PHOTO" : "VIDEO";
    const category = isPhoto ? "COVER" : "ADDITIONAL";

    // Try creating media by providing the sourceUrl directly in the request
    const createRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${locationName}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mediaFormat,
          sourceUrl: mediaItem.storageLocation, // Public Vercel Blob URL
          locationAssociation: {
            category,
          },
        }),
      },
    );

    if (!createRes.ok) {
      const errorBody = await createRes.text().catch(() => "Unable to read error body");
      console.error("[GBP] media create failed", {
        status: createRes.status,
        statusText: createRes.statusText,
        mediaFormat,
        category,
        sourceUrl: mediaItem.storageLocation,
        errorBody,
      });
      const error = new Error(`Failed to create media item in Google Business Profile: ${errorBody}`);
      (error as any).code = "GBP_CREATE_MEDIA_FAILED";
      throw error;
    }

    const created = (await createRes.json()) as { name?: string };
    const externalPostId = created.name ?? null;

    console.log("[GBP] Media created successfully", {
      externalPostId,
    });

    return {
      externalPostId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};

async function ensureLocationName(
  socialConnection: SocialConnection,
  accessToken: string,
): Promise<{ locationName: string }> {
  const metadata = (socialConnection.metadata as any) ?? {};
  const raw = metadata.locationName;

  if (typeof raw !== "string" || !raw.trim()) {
    const error = new Error(
      "Google Business Profile location is not configured. Set it from the Connections page.",
    );
    (error as any).code = "GBP_NO_LOCATION_NAME";
    throw error;
  }

  const trimmed = raw.trim();

  // If the user pasted the full resource name, use it as-is.
  if (trimmed.startsWith("accounts/")) {
    return { locationName: trimmed };
  }

  // Otherwise treat it as a Store code from Advanced settings and resolve it.
  const resolved = await resolveLocationNameFromStoreCode(accessToken, trimmed);
  return { locationName: resolved };
}

async function resolveLocationNameFromStoreCode(
  accessToken: string,
  identifier: string,
): Promise<string> {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  } as const;

  const accountManagementBase = "https://mybusinessaccountmanagement.googleapis.com/v1";
  const businessInfoBase = "https://mybusinessbusinessinformation.googleapis.com/v1";

  // 1. List all accounts the user has access to.
  const accountsRes = await fetch(`${accountManagementBase}/accounts`, {
    headers: authHeaders,
  });

  if (!accountsRes.ok) {
    console.error("[GBP] accounts.list failed while resolving store code", {
      status: accountsRes.status,
      statusText: accountsRes.statusText,
    });
    const error = new Error(
      "Failed to list Google Business Profile accounts while resolving location.",
    );
    (error as any).code = "GBP_ACCOUNTS_LIST_FAILED";
    throw error;
  }

  const accountsJson = (await accountsRes.json()) as {
    accounts?: { name?: string }[];
  };

  const accounts = accountsJson.accounts ?? [];
  const candidates: string[] = [];

  // 2. For each account, search locations by storeCode.
  for (const account of accounts) {
    const accountName = account.name; // e.g. "accounts/123456789012345678901"
    if (!accountName) continue;

    const url = new URL(`${businessInfoBase}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,storeCode,title");
    url.searchParams.set("filter", `storeCode="${identifier}"`);

    const locationsRes = await fetch(url.toString(), {
      headers: authHeaders,
    });

    if (!locationsRes.ok) {
      console.error("[GBP] accounts.locations.list failed for account", {
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

      // loc.name is "locations/{locationId}"
      const locationId = loc.name.startsWith("locations/")
        ? loc.name.slice("locations/".length)
        : loc.name;
      const [, accountId] = accountName.split("/");
      if (!accountId) continue;

      candidates.push(`accounts/${accountId}/locations/${locationId}`);
    }
  }

  if (candidates.length === 0) {
    const error = new Error(
      "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
    );
    (error as any).code = "GBP_STORE_CODE_NOT_FOUND";
    throw error;
  }

  if (candidates.length > 1) {
    const error = new Error(
      "Store code matched multiple Google Business Profile locations. Please specify a more precise identifier.",
    );
    (error as any).code = "GBP_STORE_CODE_NOT_UNIQUE";
    throw error;
  }

  return candidates[0];
}
