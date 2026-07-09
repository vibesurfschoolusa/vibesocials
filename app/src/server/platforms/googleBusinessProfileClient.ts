import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

import { resolveGbpLocationName } from "./gbpLocation";
import { refreshGoogleToken } from "./googleTokens";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Google Business Profile client (photos that appear on Google Maps)
//
// This client uses the Google Business Profile API to create media for a
// specific business location (locationName in SocialConnection.metadata) so
// photos appear on Google Maps.
//
// Token refresh is delegated to the shared `refreshGoogleToken` helper
// (src/server/platforms/googleTokens.ts), which updates ONLY accessToken +
// expiresAt (never refreshToken). It throws `GOOGLE_TOKEN_REFRESH_FAILED` on a
// non-2xx from the token endpoint (previously `GBP_TOKEN_REFRESH_FAILED`); no
// caller branches on that code — the job runner records whatever `error.code`
// is present for per-platform failure isolation.

export const googleBusinessProfileClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem } = ctx;

    // Check if token needs refresh
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[GBP] Access token expired, refreshing...");
      socialConnection = await refreshGoogleToken(socialConnection);
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Google Business Profile") as Error & { code: string };
      error.code = "GBP_NO_ACCESS_TOKEN";
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
    const createRes = await fetchWithTimeout(
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

    await assertOk(createRes, {
      code: "GBP_CREATE_MEDIA_FAILED",
      prefix: "Failed to create media item in Google Business Profile",
    });

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
    return refreshGoogleToken(connection);
  },
};

async function ensureLocationName(
  socialConnection: SocialConnection,
  accessToken: string,
): Promise<{ locationName: string }> {
  const metadata = (socialConnection.metadata as { locationName?: unknown } | null) ?? {};
  const raw = metadata.locationName;

  if (typeof raw !== "string" || !raw.trim()) {
    const error = new Error(
      "Google Business Profile location is not configured. Set it from the Connections page.",
    ) as Error & { code: string };
    error.code = "GBP_NO_LOCATION_NAME";
    throw error;
  }

  // resolveGbpLocationName handles both a full "accounts/..." resource name
  // (returned as-is) and a Store code from Advanced settings (resolved via the
  // account/location listing).
  const locationName = await resolveGbpLocationName(accessToken, raw.trim());
  return { locationName };
}
