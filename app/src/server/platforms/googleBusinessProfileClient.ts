import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { prisma } from "@/lib/db";
import { resolveGooglePostMetadata } from "@/lib/googlePostOptions";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { trackedGoogleButtonUrl } from "@/lib/trackingTags";
import { truncateGraphemes } from "@/lib/truncate";

import { refreshConnectionToken } from "./connectionRefresh";
import { resolveGbpLocationName } from "./gbpLocation";
import { refreshGoogleToken } from "./googleTokens";
import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import { budgetedTimeout } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";
import type {
  GoogleBusinessPostMetadata,
  PlatformClient,
  PublishContext,
  PublishResult,
  TextPublishContext,
} from "./types";

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
          // The options apply to a post only; a video (below) ignores them.
          body: buildLocalPostBody(ctx.caption, mediaItem.storageLocation, await resolvePostOptions(ctx)),
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

  /**
   * A post without a photo (2026-11-10): a local post with the summary and no
   * `media`. Google's LocalPost reference (read 2026-11-10,
   * https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts)
   * marks only `topicType` required (and `event` for EVENT and OFFER); `media` is
   * not. The post's own options, or the workspace's default button, apply
   * exactly as for a photo. Never the gallery: a text post is always a post.
   */
  async publishText(ctx: TextPublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { deadline } = ctx;

    // As publishVideo: refresh under the per-connection lock when expired.
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
    const body = buildLocalPostBody(ctx.caption, null, await resolvePostOptions(ctx));

    console.log("[GBP] Creating text post", { locationName });

    // The commit call, as for a photo post: a lost answer is PUBLISH_UNCONFIRMED.
    const createRes = await commitRequest("google_business_profile", () =>
      fetchWithTimeout(
        `https://mybusiness.googleapis.com/v4/${locationName}/localPosts`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      ),
    );

    const limited = await classifyRateLimit("google_business_profile", createRes);
    if (limited) throw limited;

    await assertOk(createRes, {
      code: "GBP_CREATE_POST_FAILED",
      prefix: "Failed to create the Google Business Profile post",
    });

    const created = await readCommitBody<{ name?: unknown; state?: unknown } | null>(
      "google_business_profile",
      createRes,
      "json",
    );
    const externalPostId = requireCommitId("google_business_profile", created?.name, "name");

    if (created?.state === "REJECTED") {
      const error = new Error(
        "Google rejected this Business Profile post under its content policy, so it is not shown. Edit the caption and try again.",
      ) as Error & { code: string };
      error.code = "GBP_POST_REJECTED";
      throw error;
    }

    console.log("[GBP] Text post created", { externalPostId, state: created?.state });
    return { externalPostId };
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
 * A post with no caption carries the photo alone (no empty `summary`). A null
 * `photoUrl` is a post without a photo (2026-11-10): no `media` at all.
 */
export function buildLocalPostBody(
  caption: string,
  photoUrl: string | null,
  options?: GoogleBusinessPostMetadata,
): Record<string, unknown> {
  const summary = computeGbpPostSummary(caption);
  const body: Record<string, unknown> = {
    languageCode: "en-US",
    topicType: "STANDARD",
    ...(summary ? { summary } : {}),
    ...(photoUrl !== null ? { media: [{ mediaFormat: "PHOTO", sourceUrl: photoUrl }] } : {}),
  };
  if (!options) return body;

  // 2026-11-10, Google's LocalPost reference: callToAction is ignored for an
  // OFFER (so never sent), and its url must be unset for CALL.
  if (options.button && options.postType !== "offer") {
    body.callToAction = {
      actionType: options.button.type,
      ...(options.button.type !== "CALL" && options.button.url ? { url: options.button.url } : {}),
    };
  }
  if (options.postType === "event" && options.event) {
    const { title, startDate, endDate, startTime, endTime } = options.event;
    body.topicType = "EVENT";
    body.event = { title, schedule: gbpSchedule(startDate, endDate, startTime, endTime) };
  }
  if (options.postType === "offer" && options.offer) {
    const { title, startDate, endDate, couponCode, redeemUrl, terms } = options.offer;
    body.topicType = "OFFER";
    // Google requires `event` (title + schedule) for an OFFER as well.
    body.event = { title, schedule: gbpSchedule(startDate, endDate) };
    const offer = {
      ...(couponCode ? { couponCode } : {}),
      ...(redeemUrl ? { redeemOnlineUrl: redeemUrl } : {}),
      ...(terms ? { termsConditions: terms } : {}),
    };
    if (Object.keys(offer).length > 0) body.offer = offer;
  }
  return body;
}

/**
 * Google's TimeInterval "must contain all fields to be valid", so a missing time
 * becomes the whole day: 00:00 for the start, 23:59 for the end (an offer has
 * no times at all). Dates are YYYY-MM-DD, times HH:MM, already validated
 * (lib/googlePostOptions.ts).
 */
function gbpSchedule(startDate: string, endDate: string, startTime?: string, endTime?: string) {
  const date = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return { year, month, day };
  };
  const time = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return { hours, minutes, seconds: 0, nanos: 0 };
  };
  return {
    startDate: date(startDate),
    startTime: time(startTime ?? "00:00"),
    endDate: date(endDate),
    endTime: time(endTime ?? "23:59"),
  };
}

/**
 * A photo post's options: the post's own, or, for a post that has none (from
 * before 2026-11-10, or the API), the workspace's default button. Read before
 * the create request is sent, so a failure here is safe to retry.
 *
 * With tracking tags on, a button that links to the workspace website's site is
 * tagged as a Google visit (lib/trackingTags.ts). A post whose own options have
 * no link has nothing to tag, so the workspace is not read for it. For a post
 * with its own button the read is only for the tags, so a failed read counts as
 * the setting off and the post's own button goes out unchanged; the default
 * button still needs the read, and a failure there throws as before.
 */
async function resolvePostOptions(
  ctx: Pick<TextPublishContext, "googleBusinessProfileMetadata" | "socialConnection">,
): Promise<GoogleBusinessPostMetadata | undefined> {
  const own = ctx.googleBusinessProfileMetadata;
  if (own && !own.button?.url) return own;
  const read = prisma.workspace.findUnique({
    where: { id: ctx.socialConnection.workspaceId },
    select: { googleButtonType: true, googleButtonUrl: true, companyWebsite: true, trackWebsiteLinks: true },
  });
  const workspace = own ? await read.catch(() => null) : await read;
  const options = own ?? resolveGooglePostMetadata(undefined, workspace);
  const url = options?.button?.url;
  if (!options?.button || !url || !workspace?.trackWebsiteLinks) return options;
  return { ...options, button: { ...options.button, url: trackedGoogleButtonUrl(url, workspace.companyWebsite) } };
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
