import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";

import { refreshConnectionToken } from "./connectionRefresh";
import { resolveGbpLocationName } from "./gbpLocation";
import { refreshGoogleToken } from "./googleTokens";
import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import { budgetedTimeout } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Google Business Profile client (posts that appear on Google Search and Maps)
//
// For the business location in SocialConnection.metadata.locationName, a photo
// is published as a Business Profile post (localPosts, an "Update" with the
// caption) and a video is added to the location's media gallery.
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

    const { locationName } = await ensureLocationName(socialConnection, accessToken, deadline);

    // A photo becomes a Business Profile post (an "Update" with the caption, shown
    // on Google Search and Maps). Until 2026-11 it was only added to the photo
    // gallery, without the caption. A video still goes to the gallery: Google
    // documents photos only for posts.
    const isPhoto = mediaItem.mimeType?.startsWith("image/") ?? true;

    console.log(isPhoto ? "[GBP] Creating post" : "[GBP] Adding video to the gallery", {
      locationName,
      storageLocation: mediaItem.storageLocation,
      mimeType: mediaItem.mimeType,
    });

    // 2026-11-01 scale audit (jobs H6, Review Focus 5): the POST below is the
    // commit call. A 5xx, a timeout or a dropped connection after it was sent is
    // PUBLISH_UNCONFIRMED (the post or media item may exist) and is never re-run;
    // a 4xx / 429 is returned and handled below. The timeout is clamped to the
    // remaining step budget; a spent budget throws PUBLISH_TIME_BUDGET_EXCEEDED
    // BEFORE the request is sent (safe to retry).
    const request = isPhoto
      ? {
          url: `https://mybusiness.googleapis.com/v4/${locationName}/localPosts`,
          body: buildLocalPostBody(ctx.caption, mediaItem.storageLocation),
          failure: {
            code: "GBP_CREATE_POST_FAILED",
            prefix: "Failed to create the Google Business Profile post",
          },
        }
      : {
          url: `https://mybusiness.googleapis.com/v4/${locationName}/media`,
          body: {
            mediaFormat: "VIDEO",
            sourceUrl: mediaItem.storageLocation, // Public Vercel Blob URL
            // ADDITIONAL, not COVER, to avoid COVER's strict aspect ratio.
            locationAssociation: { category: "ADDITIONAL" },
          },
          failure: {
            code: "GBP_CREATE_MEDIA_FAILED",
            prefix: "Failed to create media item in Google Business Profile",
          },
        };

    const createRes = await commitRequest("google_business_profile", () =>
      fetchWithTimeout(
        request.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request.body),
        },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      ),
    );

    // 2026-11-01 scale audit (platform limits): GBP answers an excess (300 QPM
    // per API, 10 edits/min per profile) with HTTP 429 -> RATE_LIMITED.
    const limited = await classifyRateLimit("google_business_profile", createRes);
    if (limited) throw limited;

    await assertOk(createRes, request.failure);

    // The create answered 2xx, so the post or item may exist: an unreadable body
    // is PUBLISH_UNCONFIRMED, not a failure to retry (final review F4). So is a
    // body that parsed but has no resource `name` (2026-11-02 scale audit).
    const created = await readCommitBody<{ name?: unknown; state?: unknown } | null>(
      "google_business_profile",
      createRes,
      "json",
    );
    const externalPostId = requireCommitId("google_business_profile", created?.name, "name");

    // A post Google refused under its content policy exists but is never shown.
    if (isPhoto && created?.state === "REJECTED") {
      const error = new Error(
        "Google rejected this Business Profile post under its content policy, so it is not shown. Edit the caption and try again.",
      ) as Error & { code: string };
      error.code = "GBP_POST_REJECTED";
      throw error;
    }

    console.log(isPhoto ? "[GBP] Post created" : "[GBP] Media created successfully", {
      externalPostId,
      state: created?.state,
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

/**
 * The text of a Business Profile post: the caption (with the workspace footer),
 * cut to Google's 1,500 characters the same way the composer preview shows it
 * (platformLimits.ts). Empty when there is no caption.
 */
export function computeGbpPostSummary(caption: string): string {
  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.google_business_profile;
  const text = caption.trim();
  if (charLimit === null || text.length <= charLimit) {
    return text;
  }
  return truncateGraphemes(text, charLimit, { ellipsis });
}

/**
 * The body of POST .../localPosts for one photo: a STANDARD post ("Update").
 * A post with no caption carries the photo alone (no empty `summary`).
 */
export function buildLocalPostBody(caption: string, photoUrl: string): Record<string, unknown> {
  const summary = computeGbpPostSummary(caption);
  return {
    languageCode: "en-US",
    topicType: "STANDARD",
    ...(summary ? { summary } : {}),
    media: [{ mediaFormat: "PHOTO", sourceUrl: photoUrl }],
  };
}

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
