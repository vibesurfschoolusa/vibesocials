import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { MAX_POST_MEDIA, MULTI_PHOTO_MIME_TYPES } from "@/lib/postMedia";
import { connectionTokenChangedError, flagRejectedToken } from "./connectionHealth";
import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import { META_GRAPH_BASE_URL, META_GRAPH_VIDEO_BASE_URL } from "@/lib/metaGraph";
import { mediaKindOf } from "@/lib/platformLimits";
import { budgetedTimeout } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";

// Token-material reality (see app/api/auth/facebook_page/callback/route.ts):
// `accessToken` is a Facebook PAGE access token minted from a long-lived user
// token during OAuth, `refreshToken` is always null (the user token is never
// stored), and `expiresAt` records the USER token's ~60-day expiry — not the
// page token's. Page tokens minted this way generally do not expire, so unlike
// instagramClient.ts there is deliberately NO preemptive expiry guard here (it
// would falsely block still-working connections at day 60). The real health
// signal is the Graph API rejecting the token at publish time: HTTP 401, or an
// `OAuthException` with code 190 (invalid/expired token, commonly HTTP 400) —
// both are mapped below to a clean, coded reconnect error plus the
// `needsReconnect` flag (Roadmap Phase 4, see connectionHealth.ts).

const FACEBOOK_PAGE_RECONNECT_CODE = "FACEBOOK_PAGE_RECONNECT_REQUIRED";

/**
 * How long a video upload may take. With `file_url`, Facebook downloads the
 * whole file before it answers, so this is longer than a photo's 30 s; it is
 * still cut short by the publish step's deadline (budgetedTimeout).
 */
export const FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS = 120_000;

function facebookPageReconnectRequiredError(): Error & { code: string } {
  const error = new Error(
    "Your Facebook Page connection is no longer valid — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = FACEBOOK_PAGE_RECONNECT_CODE;
  return error;
}

/**
 * True when a Graph API error body is an auth failure that only a reconnect
 * can fix: an `OAuthException` with code 190 (invalid/expired access token).
 * Facebook frequently returns these with HTTP 400, so status alone is not
 * enough. Shared with instagramClient.ts (same Graph API, same dead-token
 * signal); exported for tests.
 */
export function isFacebookAuthErrorBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; code?: number };
    };
    return (
      parsed.error?.type === "OAuthException" && parsed.error?.code === 190
    );
  } catch {
    return false;
  }
}

function publishFailedError(message: string, status?: number): Error & { code: string; status?: number } {
  const error = new Error(message) as Error & { code: string; status?: number };
  error.code = "FACEBOOK_PAGE_PUBLISH_FAILED";
  if (status !== undefined) error.status = status;
  return error;
}

/**
 * Throws for a Graph response that was not ok (rate limits already classified).
 * `status` is attached only for calls that may be repeated (photo uploads), so
 * withTransientRetries can retry their 5xx.
 */
async function throwRejected(
  response: Response,
  socialConnection: SocialConnection,
  logLabel: string,
  message: string,
  status?: number,
): Promise<never> {
  // COR-3 discipline (matches instagramClient.ts): raw upstream bodies go
  // to server logs only — PostJobResult.errorMessage renders in the UI, so
  // the thrown message carries just a prefix + status.
  const errorBody = await response
    .text()
    .catch(() => "Unable to read error body");
  console.error(`[FacebookPage] ${logLabel}`, {
    status: response.status,
    error: errorBody,
  });
  // Token no longer accepted -> the actionable reconnect error, and flag
  // the connection so the dashboard/settings Reconnect affordance lights
  // up instead of the user retrying a dead token forever. The flag is
  // guarded by the tokens this call sent (2026-11-02 scale audit, jobs,
  // token refresh): if the stored tokens changed since this publish read the
  // row (the user reconnected), nothing is flagged and the plain, retryable
  // CONNECTION_TOKEN_CHANGED is thrown.
  if (response.status === 401 || isFacebookAuthErrorBody(errorBody)) {
    const flagged = await flagRejectedToken(
      socialConnection,
      FACEBOOK_PAGE_RECONNECT_CODE,
    );
    if (flagged === "superseded") throw connectionTokenChangedError();
    throw facebookPageReconnectRequiredError();
  }
  throw publishFailedError(message, status);
}

/**
 * 07b: a post with several photos. Per the Page photos reference
 * (https://developers.facebook.com/docs/graph-api/reference/page/photos/,
 * "Publishing Multiple Photos"): each photo is uploaded to /{page}/photos with
 * `published=false`, then one POST /{page}/feed names them all as
 * `attached_media[i]={"media_fbid":"<photo id>"}`, in order. Unpublished photos
 * that never get attached are deleted by Facebook after 24 hours, so a failed
 * or repeated upload leaves nothing visible; only the feed post is the commit
 * call. Its id ("<page>_<post>") is recorded like the single photo's id.
 */
async function publishSeveralPhotos(
  ctx: PublishContext,
  accessToken: string,
  pageId: string,
): Promise<PublishResult> {
  const { socialConnection, mediaItems, caption } = ctx;

  if (mediaItems.length > MAX_POST_MEDIA) {
    const error = new Error(
      `Facebook Page posts here can carry at most ${MAX_POST_MEDIA} photos. Remove some photos and try again.`,
    ) as Error & { code: string };
    error.code = "FACEBOOK_PAGE_TOO_MANY_PHOTOS";
    throw error;
  }
  if (mediaItems.some((item) => !MULTI_PHOTO_MIME_TYPES.includes(item.mimeType ?? ""))) {
    const error = new Error(
      "A Facebook Page post with several photos takes JPEG, PNG or WebP photos only.",
    ) as Error & { code: string };
    error.code = "FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }

  const total = mediaItems.length;
  console.log("[FacebookPage] Starting multi-photo publish", {
    pageId,
    photoCount: total,
    captionLength: caption?.length ?? 0,
  });

  const photoIds: string[] = [];
  for (const [index, item] of mediaItems.entries()) {
    const which = `photo ${index + 1} of ${total}`;
    // An upload is not a commit (the photo stays unpublished), so a plain
    // fetch: a 5xx or a network failure here may be retried.
    const response = await fetchWithTimeout(
      `${META_GRAPH_BASE_URL}/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          url: item.storageLocation,
          published: "false",
          access_token: accessToken,
        }),
      },
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline),
    );

    const limited = await classifyRateLimit("facebook_page", response);
    if (limited) throw limited;
    if (!response.ok) {
      await throwRejected(
        response,
        socialConnection,
        `Upload of ${which} failed`,
        `Facebook Page could not upload ${which} (status ${response.status}). No post was made.`,
        response.status,
      );
    }
    const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof data?.id !== "string" || data.id.length === 0) {
      console.error(`[FacebookPage] Upload of ${which} answered without a photo id`);
      throw publishFailedError(`Facebook Page could not upload ${which}. No post was made.`);
    }
    photoIds.push(data.id);
  }

  const body = new URLSearchParams({ message: caption ?? "" });
  photoIds.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  body.append("access_token", accessToken);

  // Checked before the commit call, so a spent step budget sends nothing.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline);
  const response = await commitRequest("facebook_page", () =>
    fetchWithTimeout(
      `${META_GRAPH_BASE_URL}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      timeoutMs,
    ),
  );

  const limited = await classifyRateLimit("facebook_page", response);
  if (limited) throw limited;
  if (!response.ok) {
    await throwRejected(
      response,
      socialConnection,
      "Multi-photo feed post failed",
      `Facebook Page photos publish failed (status ${response.status})`,
    );
  }

  const data = await readCommitBody<{ id?: unknown } | null>("facebook_page", response, "json");
  const externalPostId = requireCommitId("facebook_page", data?.id, "id");

  console.log("[FacebookPage] Multi-photo post published", {
    pageId,
    externalPostId,
    photoCount: total,
  });

  return { externalPostId };
}

export const facebookPageClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Facebook Page") as Error & { code: string };
      error.code = "FACEBOOK_PAGE_NO_ACCESS_TOKEN";
      throw error;
    }

    const pageId = socialConnection.accountIdentifier;
    if (!pageId) {
      const error = new Error("Missing Facebook Page ID") as Error & { code: string };
      error.code = "FACEBOOK_PAGE_NO_ID";
      throw error;
    }

    if (ctx.mediaItems.length > 1) {
      return publishSeveralPhotos(ctx, accessToken, pageId);
    }

    const kind = mediaKindOf(mediaItem.mimeType ?? "");
    if (kind === null) {
      const error = new Error(
        "Facebook Page posting supports images and videos. Please upload a photo or a video.",
      ) as Error & { code: string };
      error.code = "FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE";
      throw error;
    }
    const isVideo = kind === "video";
    const what = isVideo ? "video" : "photo";

    console.log(`[FacebookPage] Starting ${what} publish`, {
      pageId,
      storageLocation: mediaItem.storageLocation,
      captionLength: caption?.length ?? 0,
    });

    // A photo goes to /{page}/photos with `url` + `caption`. A video goes to
    // /{page}/videos on graph-video.facebook.com with `file_url` + `description`:
    // Meta fetches the file itself, as Instagram does for Reels
    // (https://developers.facebook.com/docs/graph-api/reference/page/videos/).
    // Both need pages_manage_posts, pages_read_engagement and pages_show_list.
    const endpoint = isVideo
      ? new URL(`${META_GRAPH_VIDEO_BASE_URL}/${pageId}/videos`)
      : new URL(`${META_GRAPH_BASE_URL}/${pageId}/photos`);

    const body = isVideo
      ? new URLSearchParams({
          file_url: mediaItem.storageLocation,
          description: caption ?? "",
          access_token: accessToken,
        })
      : new URLSearchParams({
          url: mediaItem.storageLocation,
          caption: caption ?? "",
          access_token: accessToken,
        });

    // Checked before the commit call, so a spent step budget sends nothing.
    const timeoutMs = isVideo
      ? budgetedTimeout(FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS, ctx.deadline)
      : undefined;

    // 2026-11-01 scale audit (jobs H6, Review Focus 5): POST /{page}/photos (or
    // /videos) is the commit call. A 5xx, a timeout or a dropped connection
    // after it was sent is PUBLISH_UNCONFIRMED (the post may be live) and is
    // never re-run; a 4xx / 429 is returned and handled below as before.
    const response = await commitRequest("facebook_page", () =>
      fetchWithTimeout(
        endpoint.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
        timeoutMs,
      ),
    );

    // 2026-11-01 scale audit (platform limits): a Meta throttle (code 4, 17, 32,
    // 613, 80001 or HTTP 429) is RATE_LIMITED, with the wait from the
    // X-Business-Use-Case-Usage header, not FACEBOOK_PAGE_PUBLISH_FAILED.
    const limited = await classifyRateLimit("facebook_page", response);
    if (limited) throw limited;

    if (!response.ok) {
      await throwRejected(
        response,
        socialConnection,
        `${isVideo ? "Video" : "Photo"} publish failed`,
        `Facebook Page ${what} publish failed (status ${response.status})`,
      );
    }

    // photos/videos answered 2xx, so the post may be live: an unreadable body is
    // PUBLISH_UNCONFIRMED, not a failure to retry (final review F4). So is a body
    // that parsed but names neither `id` nor `post_id` (2026-11-02 scale audit).
    const data = await readCommitBody<{ id?: unknown; post_id?: unknown } | null>(
      "facebook_page",
      response,
      "json",
    );
    const externalPostId = requireCommitId(
      "facebook_page",
      data?.id ?? data?.post_id,
      "id or post_id",
    );

    console.log(`[FacebookPage] ${isVideo ? "Video" : "Photo"} published`, {
      pageId,
      externalPostId,
    });

    return {
      externalPostId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    // Nothing to refresh: no user token is stored (refreshToken is null) and
    // the page token itself does not expire on a schedule — see the
    // token-material note at the top of this file. A genuinely dead token is
    // detected and flagged at publish time above.
    return connection;
  },
};
