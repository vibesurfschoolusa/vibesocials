import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";

import { refreshConnectionToken } from "./connectionRefresh";
import { resolveGbpLocationName } from "./gbpLocation";
import { refreshGoogleToken } from "./googleTokens";
import { commitRequest, readCommitBody } from "./commitCall";
import { budgetedTimeout } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";
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
    const { mediaItem, deadline } = ctx;

    // Check if token needs refresh. 2026-11-01 scale audit (step budget, Task 7):
    // every request below ends by the step deadline (ctx.deadline) and none is
    // started with under 5 s left (PUBLISH_TIME_BUDGET_EXCEEDED, nothing sent).
    // The refresh runs under the per-connection lock (2026-11-01 scale audit,
    // jobs, token refresh), so a concurrent publish or the health sweep never
    // refreshes the same connection at once.
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[GBP] Access token expired, refreshing...");
      socialConnection = await refreshConnectionToken(
        socialConnection,
        (current) => refreshGoogleToken(current, { deadline }),
        { deadline },
      );
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

    const { locationName } = await ensureLocationName(socialConnection, accessToken, deadline);

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
    // 2026-11-01 scale audit (jobs H6, Review Focus 5): POST .../media is the
    // commit call. A 5xx, a timeout or a dropped connection after it was sent is
    // PUBLISH_UNCONFIRMED (the media item may exist) and is never re-run; a 4xx /
    // 429 is returned and handled below as before. The timeout is clamped to
    // the remaining step budget; a spent budget throws
    // PUBLISH_TIME_BUDGET_EXCEEDED BEFORE the request is sent (safe to retry).
    const createRes = await commitRequest("google_business_profile", () =>
      fetchWithTimeout(
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
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      ),
    );

    // 2026-11-01 scale audit (platform limits): GBP answers an excess (300 QPM
    // per API, 10 edits/min per profile) with HTTP 429 -> RATE_LIMITED.
    const limited = await classifyRateLimit("google_business_profile", createRes);
    if (limited) throw limited;

    await assertOk(createRes, {
      code: "GBP_CREATE_MEDIA_FAILED",
      prefix: "Failed to create media item in Google Business Profile",
    });

    // The media create answered 2xx, so the item may exist: an unreadable body
    // is PUBLISH_UNCONFIRMED, not a failure to retry (final review F4).
    const created = await readCommitBody<{ name?: string }>("google_business_profile", createRes, "json");
    const externalPostId = created.name ?? null;

    console.log("[GBP] Media created successfully", {
      externalPostId,
    });

    return {
      externalPostId,
    };
  },

  async refreshToken(
    connection: SocialConnection,
    opts?: { deadline?: number },
  ): Promise<SocialConnection> {
    return refreshGoogleToken(connection, opts);
  },
};

async function ensureLocationName(
  socialConnection: SocialConnection,
  accessToken: string,
  deadline?: number,
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
  const locationName = await resolveGbpLocationName(accessToken, raw.trim(), deadline);
  return { locationName };
}
