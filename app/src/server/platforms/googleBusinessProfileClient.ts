import type { SocialConnection } from "@prisma/client";

import { resolveGbpLocationName } from "./gbpLocation";
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
    // Use ADDITIONAL instead of COVER to avoid strict aspect ratio requirements
    const category = "ADDITIONAL";

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

  // resolveGbpLocationName handles both a full "accounts/..." resource name
  // (returned as-is) and a Store code from Advanced settings (resolved via the
  // account/location listing).
  const locationName = await resolveGbpLocationName(accessToken, raw.trim());
  return { locationName };
}
