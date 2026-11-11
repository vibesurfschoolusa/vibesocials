import type { PlatformClient, PublishContext, PublishResult, TextPublishContext } from "./types";
import type { SocialConnection } from "@prisma/client";

import { altTextOf } from "@/lib/altText";
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
 * 07d: Page photos reference (read 2026-11-10,
 * https://developers.facebook.com/docs/graph-api/reference/page/photos/): `alt_text_custom`,
 * "Accessible alternative description for an image", among the Creating parameters. The
 * page states no length limit, so the app's own cap (lib/altText.ts) applies.
 */
const FACEBOOK_ALT_TEXT_LIMIT = 1000;

/** The photo request's body with `alt_text_custom` added last, only when the photo has a description. */
function withAltText(body: URLSearchParams, item: PublishContext["mediaItem"]): URLSearchParams {
  const altText = altTextOf(item, FACEBOOK_ALT_TEXT_LIMIT);
  if (altText) body.append("alt_text_custom", altText);
  return body;
}

/**
 * 07d: whether a photo upload that carried `alt_text_custom` should be sent once more
 * without it. Neither Facebook's length limit nor the parameter on an unpublished photo is
 * confirmed, so a description must never cost the post: any 4xx refusal that is not about
 * the token qualifies. Rate limits are classified (and thrown) before this is asked. A 4xx
 * means Facebook made nothing, so the second send cannot duplicate a photo or a post. The
 * body is read from a clone, so the caller can still read it.
 */
async function refusedForDescription(body: URLSearchParams, response: Response): Promise<boolean> {
  if (!body.has("alt_text_custom")) return false;
  if (response.status < 400 || response.status >= 500 || response.status === 401) return false;
  const text = await response.clone().text().catch(() => "");
  return !isFacebookAuthErrorBody(text);
}

/** The same body without the description, logged without its text. */
function withoutAltText(body: URLSearchParams, label: string, status: number): URLSearchParams {
  console.warn(`[FacebookPage] ${label} refused with its description; sending it once more without the description`, {
    status,
  });
  const plain = new URLSearchParams(body);
  plain.delete("alt_text_custom");
  return plain;
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
    const upload = (body: URLSearchParams) =>
      fetchWithTimeout(
        `${META_GRAPH_BASE_URL}/${pageId}/photos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline),
      );
    const body = withAltText(
      new URLSearchParams({
        url: item.storageLocation,
        published: "false",
        access_token: accessToken,
      }),
      item,
    );
    let response = await upload(body);

    let limited = await classifyRateLimit("facebook_page", response);
    if (limited) throw limited;
    // 07d: a refused description must not cost the post. Only the photo id of the
    // upload that succeeds is attached, so no photo can be in the post twice.
    if (await refusedForDescription(body, response)) {
      response = await upload(withoutAltText(body, `Upload of ${which}`, response.status));
      limited = await classifyRateLimit("facebook_page", response);
      if (limited) throw limited;
    }
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

/**
 * The Story's id from a 2xx commit body. The Page Stories page shows `post_id`
 * as a number in its example (`"post_id": 1234`), so a number is accepted too;
 * anything else is PUBLISH_UNCONFIRMED (requireCommitId).
 */
function storyPostId(value: unknown): string {
  return requireCommitId("facebook_page", typeof value === "number" ? String(value) : value, "post_id");
}

/** The upload address a video Story start answers. The page says the host must be rupload.facebook.com. */
function isRuploadUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "rupload.facebook.com";
  } catch {
    return false;
  }
}

/**
 * 2026-11-10: one photo or one video to the Page's Story, per the Page Stories
 * API (https://developers.facebook.com/docs/page-stories-api, read 2026-11-10;
 * the same pages_manage_posts, pages_read_engagement and pages_show_list as a
 * feed post). A Story has no caption, so none is sent.
 *
 * Photo: POST /{page}/photos with `published=false` (nothing visible; may be
 * repeated, as in publishSeveralPhotos), then POST /{page}/photo_stories with
 * `photo_id`, the commit call.
 * Video: POST /{page}/video_stories `upload_phase=start` (answers `video_id`
 * and `upload_url`), POST the hosted file to `upload_url` with `file_url` and
 * `Authorization: OAuth <token>` headers (both may be repeated: a new start
 * makes a new, unused video), then POST /{page}/video_stories
 * `upload_phase=finish` with `video_id`, the commit call.
 *
 * The commit call goes through commitRequest, so a lost answer is
 * PUBLISH_UNCONFIRMED and never sent again. Both answer `success` and
 * `post_id`, no link, so only the id is returned.
 */
async function publishStory(
  ctx: PublishContext,
  accessToken: string,
  pageId: string,
  isVideo: boolean,
): Promise<PublishResult> {
  const { socialConnection, mediaItem } = ctx;
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, access_token: accessToken }),
  });
  const storiesUrl = `${META_GRAPH_BASE_URL}/${pageId}/${isVideo ? "video_stories" : "photo_stories"}`;

  console.log(`[FacebookPage] Starting ${isVideo ? "video" : "photo"} Story`, { pageId });

  let commitFields: Record<string, string>;
  if (isVideo) {
    const start = await fetchWithTimeout(
      storiesUrl,
      form({ upload_phase: "start" }),
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline),
    );
    const startLimited = await classifyRateLimit("facebook_page", start);
    if (startLimited) throw startLimited;
    if (!start.ok) {
      await throwRejected(
        start,
        socialConnection,
        "Video Story start failed",
        `Facebook Page could not start the video Story (status ${start.status}). No Story was made.`,
        start.status,
      );
    }
    const started = (await start.json().catch(() => null)) as { video_id?: unknown; upload_url?: unknown } | null;
    const videoId = typeof started?.video_id === "number" ? String(started.video_id) : started?.video_id;
    if (typeof videoId !== "string" || videoId.length === 0 || !isRuploadUrl(started?.upload_url)) {
      console.error("[FacebookPage] Video Story start answered without a video id or a rupload address");
      throw publishFailedError("Facebook Page could not start the video Story. No Story was made.");
    }

    // Facebook fetches the file before it answers, so this gets the feed video's
    // longer timeout, cut short by the step's deadline.
    const transfer = await fetchWithTimeout(
      started.upload_url as string,
      {
        method: "POST",
        headers: { Authorization: `OAuth ${accessToken}`, file_url: mediaItem.storageLocation },
      },
      budgetedTimeout(FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS, ctx.deadline),
    );
    const transferLimited = await classifyRateLimit("facebook_page", transfer);
    if (transferLimited) throw transferLimited;
    // A body that is not JSON is not a refusal, so it may go on to finish.
    const transferred = transfer.ok
      ? ((await transfer.json().catch(() => null)) as { success?: unknown; error?: unknown } | null)
      : null;
    if (!transfer.ok) {
      await throwRejected(
        transfer,
        socialConnection,
        "Video Story transfer failed",
        `Facebook Page could not fetch the video for the Story (status ${transfer.status}). No Story was made.`,
        transfer.status,
      );
    }
    // A 200 can still carry a Graph error. Nothing is published before finish,
    // so this fails the transfer and a retry is safe. Only the error's numeric
    // code and type are logged: its message may quote the request, token included.
    if (transferred?.success === false || (transferred?.error !== undefined && transferred.error !== null)) {
      const graphError = (transferred.error ?? {}) as { code?: unknown; type?: unknown };
      console.error("[FacebookPage] Video Story transfer answered with an error", {
        code: typeof graphError.code === "number" ? graphError.code : undefined,
        type: typeof graphError.type === "string" ? graphError.type : undefined,
      });
      throw publishFailedError("Facebook Page could not fetch the video for the Story. No Story was made.");
    }
    commitFields = { video_id: videoId, upload_phase: "finish" };
  } else {
    const upload = await fetchWithTimeout(
      `${META_GRAPH_BASE_URL}/${pageId}/photos`,
      form({ url: mediaItem.storageLocation, published: "false" }),
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline),
    );
    const uploadLimited = await classifyRateLimit("facebook_page", upload);
    if (uploadLimited) throw uploadLimited;
    if (!upload.ok) {
      await throwRejected(
        upload,
        socialConnection,
        "Story photo upload failed",
        `Facebook Page could not upload the photo for the Story (status ${upload.status}). No Story was made.`,
        upload.status,
      );
    }
    const uploaded = (await upload.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof uploaded?.id !== "string" || uploaded.id.length === 0) {
      console.error("[FacebookPage] Story photo upload answered without a photo id");
      throw publishFailedError("Facebook Page could not upload the photo for the Story. No Story was made.");
    }
    commitFields = { photo_id: uploaded.id };
  }

  // Checked before the commit call, so a spent step budget sends nothing.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline);
  const response = await commitRequest("facebook_page", () =>
    fetchWithTimeout(storiesUrl, form(commitFields), timeoutMs),
  );

  const limited = await classifyRateLimit("facebook_page", response);
  if (limited) throw limited;
  if (!response.ok) {
    await throwRejected(
      response,
      socialConnection,
      `${isVideo ? "Video" : "Photo"} Story publish failed`,
      `Facebook Page ${isVideo ? "video" : "photo"} Story publish failed (status ${response.status})`,
    );
  }

  const data = await readCommitBody<{ post_id?: unknown } | null>("facebook_page", response, "json");
  const externalPostId = storyPostId(data?.post_id);

  console.log("[FacebookPage] Story published", { pageId, externalPostId });
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

    const story = ctx.facebookMetadata?.placement === "story";

    if (ctx.mediaItems.length > 1) {
      // The posts route refuses this; a Story is never quietly turned into a feed post.
      if (story) {
        const error = new Error(
          "A Story takes one photo or video. Choose Feed for Facebook Page, or remove the extra photos.",
        ) as Error & { code: string };
        error.code = "FACEBOOK_PAGE_STORY_ONE_FILE";
        throw error;
      }
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

    if (story) {
      return publishStory(ctx, accessToken, pageId, isVideo);
    }

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
      : withAltText(
          new URLSearchParams({
            url: mediaItem.storageLocation,
            caption: caption ?? "",
            access_token: accessToken,
          }),
          mediaItem,
        );

    // Checked before the commit call, so a spent step budget sends nothing.
    const timeoutMs = isVideo
      ? budgetedTimeout(FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS, ctx.deadline)
      : undefined;

    // 2026-11-01 scale audit (jobs H6, Review Focus 5): POST /{page}/photos (or
    // /videos) is the commit call. A 5xx, a timeout or a dropped connection
    // after it was sent is PUBLISH_UNCONFIRMED (the post may be live) and is
    // never re-run; a 4xx / 429 is returned and handled below as before.
    const send = (requestBody: URLSearchParams) =>
      commitRequest("facebook_page", () =>
        fetchWithTimeout(
          endpoint.toString(),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: requestBody,
          },
          timeoutMs,
        ),
      );
    let response = await send(body);

    // 2026-11-01 scale audit (platform limits): a Meta throttle (code 4, 17, 32,
    // 613, 80001 or HTTP 429) is RATE_LIMITED, with the wait from the
    // X-Business-Use-Case-Usage header, not FACEBOOK_PAGE_PUBLISH_FAILED.
    let limited = await classifyRateLimit("facebook_page", response);
    if (limited) throw limited;

    // 07d: a photo refused with its description is sent once more without it. The
    // first send was answered with a 4xx, so nothing was published; a 5xx, a timeout
    // or a dropped connection never gets here (commitRequest: PUBLISH_UNCONFIRMED).
    if (await refusedForDescription(body, response)) {
      response = await send(withoutAltText(body, "Photo", response.status));
      limited = await classifyRateLimit("facebook_page", response);
      if (limited) throw limited;
    }

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

  /**
   * A post without a photo (2026-11-10): POST /{page}/feed with `message`, per
   * the Pages API "Publish a Post" page
   * (https://developers.facebook.com/docs/pages-api/posts/, read 2026-11-10),
   * which answers `{ "id": "<page>_<post>" }`. The same call publishSeveralPhotos
   * makes, so the same Page token and permissions. It is the commit call: a lost
   * answer is PUBLISH_UNCONFIRMED and is never sent again.
   */
  async publishText(ctx: TextPublishContext): Promise<PublishResult> {
    const { socialConnection, caption } = ctx;

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

    console.log("[FacebookPage] Starting text post", { pageId, captionLength: caption?.length ?? 0 });

    const body = new URLSearchParams({ message: caption ?? "", access_token: accessToken });
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
        "Text post failed",
        `Facebook Page post failed (status ${response.status})`,
      );
    }

    const data = await readCommitBody<{ id?: unknown } | null>("facebook_page", response, "json");
    const externalPostId = requireCommitId("facebook_page", data?.id, "id");

    console.log("[FacebookPage] Text post published", { pageId, externalPostId });
    return { externalPostId };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    // Nothing to refresh: no user token is stored (refreshToken is null) and
    // the page token itself does not expire on a schedule — see the
    // token-material note at the top of this file. A genuinely dead token is
    // detected and flagged at publish time above.
    return connection;
  },
};
