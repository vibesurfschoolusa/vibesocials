import type { SocialConnection } from "@prisma/client";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";

import { commitRequest } from "./commitCall";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";

/** Upper bound on waiting for X to process an uploaded video (with or without a step deadline). */
export const X_PROCESSING_MAX_WAIT_MS = 120_000;
/** X's `check_after_secs` is clamped to [1s, 15s] between STATUS checks. */
export const X_STATUS_MAX_INTERVAL_MS = 15_000;
const X_STATUS_MIN_INTERVAL_MS = 1_000;
/** Timeout of one STATUS check. */
const X_STATUS_TIMEOUT_MS = 15_000;
/** Step time kept back after processing for creating the tweet (v1, then the v2 fallback). */
export const X_TWEET_RESERVE_MS = 20_000;
/** Per-request timeouts (each further clamped to the step's time left). */
const X_DOWNLOAD_TIMEOUT_MS = 120_000;
const X_UPLOAD_TIMEOUT_MS = 120_000;

/*
 * STEP BUDGET (2026-11-01 audit, Task 4 item 7). One X step must end well
 * inside Vercel's 300s per-invocation cap. publishToPlatform stamps a deadline
 * PUBLISH_STEP_BUDGET_MS = 225s after the step starts (publishBudget.ts) and
 * passes it as ctx.deadline; the worst case per phase:
 *
 *   download                  <= min(120s, time left), whole transfer
 *   INIT / FINALIZE           each <= min(30s, time left)
 *   APPEND chunks / image     each <= min(120s, time left)
 *   STATUS polling            ends by stopBy = min(start + 120s
 *                             (X_PROCESSING_MAX_WAIT_MS), deadline - 20s
 *                             (X_TWEET_RESERVE_MS)): a wait (check_after_secs
 *                             clamped to [1s, 15s]) is only started if it plus a
 *                             >= 5s check fit before stopBy, and each check
 *                             (<= 15s) is clamped to it; else
 *                             X_VIDEO_PROCESSING_TIMEOUT — no tweet was created,
 *                             so a retry cannot double-post
 *   tweet create (v1 -> v2)   each <= min(30s, time left)
 *   in-step retries           2s / 8s backoff, only with >= 60s left
 *                             (MIN_RETRY_WINDOW_MS); the retried attempt is
 *                             clamped to the same deadline
 *   no request starts with < 5s left (PUBLISH_TIME_BUDGET_EXCEEDED: nothing sent)
 *
 * => all X I/O ends by the deadline (225s): every phase that can start late is
 *    clamped to it. After it only the PostJobResult write runs (ms), so the step
 *    ends < 240s. Small JSON bodies are read after their headers and are not
 *    separately timed (same as every client).
 * Before: polling alone allowed 60 x (check_after_secs + a 30s request) > 300s,
 * and each in-step retry restarted download + upload + polling from scratch.
 */

// COR-2/COR-3: xClient uses oauth-1.0a request signing (see `oauth.authorize`
// calls below). fetchWithTimeout passes `init` through unchanged except for
// `signal` (see its docstring), so migrating `fetch(url, init)` calls here to
// `fetchWithTimeout(url, init, timeoutMs)` preserves the exact URL/method/
// headers/body the signature was computed over — only a composed abort
// signal is added, which the signature does not cover.

/**
 * Apply X's client-enforced caption truncation the same way `publishVideo`
 * does, reading the limit/ellipsis from the shared `platformLimits.ts` map
 * instead of inline literals. Extracted as a pure, exported function so this
 * behavior can be asserted directly in tests without mocking the OAuth/media-
 * upload network calls the rest of `publishVideo` makes — see xClient.test.ts.
 *
 * Behavior is intentionally unchanged from before the platformLimits.ts
 * refactor: the `.length > charLimit` pre-check is a fast-path (grapheme
 * count can never exceed UTF-16 length, so it never changes the outcome,
 * only skips the Intl.Segmenter call when definitely under the limit).
 */
export function computeTweetText(caption: string): string {
  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.x;
  // x's charLimit is always a number (see platformLimits.ts); the null check
  // only exists to satisfy the shared `Record<Platform, ...>` type.
  if (charLimit === null) {
    return caption;
  }

  let tweetText = caption;
  if (tweetText.length > charLimit) {
    const truncated = truncateGraphemes(tweetText, charLimit, { ellipsis });
    if (truncated !== tweetText) {
      console.log("[X OAuth 1.0a] Caption truncated to fit X's 280-character limit");
      tweetText = truncated;
    }
  }
  return tweetText;
}

/**
 * OAuth 1.0a tokens don't expire, no refresh needed
 */
async function refreshAccessToken(connection: SocialConnection): Promise<SocialConnection> {
  // OAuth 1.0a tokens don't expire
  console.log("[X OAuth 1.0a] Tokens don't expire, no refresh needed");
  return connection;
}

/**
 * Upload media to X (Twitter) using Media Upload API v1.1 with OAuth 1.0a
 * Returns media_id_string for use in tweet creation
 */
async function uploadMedia(
  consumerKey: string,
  consumerSecret: string,
  accessToken: string,
  accessTokenSecret: string,
  mediaUrl: string,
  mimeType: string,
  deadline: number | undefined,
): Promise<string> {
  console.log("[X OAuth 1.0a] Starting media upload", { mediaUrl, mimeType });

  // Download media from Vercel Blob.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
  const downloadTimeoutMs = budgetedTimeout(X_DOWNLOAD_TIMEOUT_MS, deadline);
  const mediaResponse = await fetchWithTimeout(
    mediaUrl,
    { signal: AbortSignal.timeout(downloadTimeoutMs) },
    downloadTimeoutMs,
  );
  await assertOk(mediaResponse, {
    code: "X_MEDIA_DOWNLOAD_FAILED",
    prefix: "Failed to fetch media from storage",
  });

  const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());

  console.log("[X OAuth 1.0a] Media downloaded", {
    sizeBytes: mediaBuffer.length,
    sizeMB: (mediaBuffer.length / 1024 / 1024).toFixed(2),
  });

  // Create OAuth client
  const oauth = new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base_string, key) {
      return crypto.createHmac("sha1", key).update(base_string).digest("base64");
    },
  });

  const token = {
    key: accessToken,
    secret: accessTokenSecret,
  };

  const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
  const isVideo = mimeType.startsWith("video/");

  // Videos require chunked upload (INIT -> APPEND -> FINALIZE)
  if (isVideo) {
    return await uploadVideoChunked(oauth, token, uploadUrl, mediaBuffer, mimeType, deadline);
  }

  // Images can use simple base64 upload
  const mediaBase64 = mediaBuffer.toString("base64");
  const requestData = {
    url: uploadUrl,
    method: "POST",
    data: {
      media_data: mediaBase64,
    },
  };

  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        media_data: mediaBase64,
      }),
    },
    budgetedTimeout(X_UPLOAD_TIMEOUT_MS, deadline),
  );

  // 2026-11-01 scale audit (platform limits): a 429 is RATE_LIMITED, not *_FAILED.
  const imageLimited = await classifyRateLimit("x", uploadResponse);
  if (imageLimited) throw imageLimited;

  await assertOk(uploadResponse, {
    code: "X_IMAGE_UPLOAD_FAILED",
    prefix: "X media upload failed",
  });

  const uploadResult = (await uploadResponse.json()) as {
    media_id_string: string;
  };

  console.log("[X OAuth 1.0a] Media uploaded successfully", {
    mediaId: uploadResult.media_id_string,
  });

  return uploadResult.media_id_string;
}

/**
 * Upload video using chunked upload (INIT -> APPEND -> FINALIZE)
 */
async function uploadVideoChunked(
  oauth: OAuth,
  token: { key: string; secret: string },
  uploadUrl: string,
  mediaBuffer: Buffer,
  mimeType: string,
  deadline: number | undefined,
): Promise<string> {
  const totalBytes = mediaBuffer.length;
  const chunkSize = 5 * 1024 * 1024; // 5MB chunks

  console.log("[X OAuth 1.0a] Starting chunked video upload", {
    totalBytes,
    chunkSize,
    chunks: Math.ceil(totalBytes / chunkSize),
  });

  // INIT
  const initData = {
    url: uploadUrl,
    method: "POST",
    data: {
      command: "INIT",
      total_bytes: totalBytes.toString(),
      media_type: mimeType,
      media_category: "tweet_video",
    },
  };

  const initAuthHeader = oauth.toHeader(oauth.authorize(initData, token));
  const initResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        ...initAuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(initData.data),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const initLimited = await classifyRateLimit("x", initResponse);
  if (initLimited) throw initLimited;

  await assertOk(initResponse, {
    code: "X_VIDEO_INIT_FAILED",
    prefix: "X video upload initialization failed",
  });

  const initResult = (await initResponse.json()) as { media_id_string: string };
  const mediaId = initResult.media_id_string;

  console.log("[X OAuth 1.0a] Video INIT successful", { mediaId });

  // APPEND chunks
  let segmentIndex = 0;
  for (let i = 0; i < totalBytes; i += chunkSize) {
    const chunk = mediaBuffer.subarray(i, Math.min(i + chunkSize, totalBytes));
    const chunkBase64 = chunk.toString("base64");

    console.log("[X OAuth 1.0a] Uploading chunk", {
      segmentIndex,
      chunkSize: chunk.length,
      progress: `${Math.min(i + chunkSize, totalBytes)}/${totalBytes}`,
    });

    const appendData = {
      url: uploadUrl,
      method: "POST",
      data: {
        command: "APPEND",
        media_id: mediaId,
        segment_index: segmentIndex.toString(),
        media_data: chunkBase64,
      },
    };

    const appendAuthHeader = oauth.toHeader(oauth.authorize(appendData, token));
    const appendResponse = await fetchWithTimeout(
      uploadUrl,
      {
        method: "POST",
        headers: {
          ...appendAuthHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(appendData.data),
      },
      budgetedTimeout(X_UPLOAD_TIMEOUT_MS, deadline),
    );

    const appendLimited = await classifyRateLimit("x", appendResponse);
    if (appendLimited) throw appendLimited;

    await assertOk(appendResponse, {
      code: "X_VIDEO_APPEND_FAILED",
      prefix: `X video APPEND failed (segment ${segmentIndex})`,
    });

    segmentIndex++;
  }

  console.log("[X OAuth 1.0a] All chunks uploaded, finalizing...");

  // FINALIZE
  const finalizeData = {
    url: uploadUrl,
    method: "POST",
    data: {
      command: "FINALIZE",
      media_id: mediaId,
    },
  };

  const finalizeAuthHeader = oauth.toHeader(oauth.authorize(finalizeData, token));
  const finalizeResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        ...finalizeAuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(finalizeData.data),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const finalizeLimited = await classifyRateLimit("x", finalizeResponse);
  if (finalizeLimited) throw finalizeLimited;

  await assertOk(finalizeResponse, {
    code: "X_VIDEO_FINALIZE_FAILED",
    prefix: "X video upload finalization failed",
  });

  const finalizeResult = (await finalizeResponse.json()) as {
    media_id_string: string;
    processing_info?: {
      state: string;
      check_after_secs?: number;
    };
  };

  console.log("[X OAuth 1.0a] Video upload finalized", {
    mediaId: finalizeResult.media_id_string,
    processingInfo: finalizeResult.processing_info,
  });

  // If video is still processing, poll STATUS until complete
  if (finalizeResult.processing_info) {
    await waitForVideoProcessing(
      oauth,
      token,
      uploadUrl,
      mediaId,
      finalizeResult.processing_info,
      deadline,
    );
  }

  return finalizeResult.media_id_string;
}

/** X's media processing did not finish in time; no tweet was created. */
function xProcessingTimeoutError(): Error & { code: string } {
  const error = new Error(
    "X is still processing the video. No post was created — please retry in a few minutes.",
  ) as Error & { code: string };
  error.code = "X_VIDEO_PROCESSING_TIMEOUT";
  return error;
}

/** X reported the media processing as failed. */
function xProcessingFailedError(): Error & { code: string } {
  const error = new Error(
    "X reported an error while processing the uploaded video",
  ) as Error & { code: string };
  error.code = "X_VIDEO_PROCESSING_FAILED";
  return error;
}

/**
 * Poll STATUS until X has processed the video. Bounded (see STEP BUDGET at the
 * top of this file): polling ends by `stopBy` — at most X_PROCESSING_MAX_WAIT_MS
 * from now, and X_TWEET_RESERVE_MS before the step deadline. Each wait is
 * clamped to [1s, 15s] and only started if it plus a >= 5s check fit before
 * `stopBy`; each check is clamped to it. Running out throws
 * X_VIDEO_PROCESSING_TIMEOUT before any tweet exists.
 */
async function waitForVideoProcessing(
  oauth: OAuth,
  token: { key: string; secret: string },
  uploadUrl: string,
  mediaId: string,
  initialProcessingInfo: { state: string; check_after_secs?: number },
  deadline: number | undefined,
): Promise<void> {
  let processingInfo: {
    state: string;
    check_after_secs?: number;
    progress_percent?: number;
    error?: { message: string; code: number };
  } = initialProcessingInfo;
  // Polling must end early enough to leave the tweet its reserve.
  const stopBy = Math.min(
    Date.now() + X_PROCESSING_MAX_WAIT_MS,
    deadline === undefined ? Number.POSITIVE_INFINITY : deadline - X_TWEET_RESERVE_MS,
  );
  let checks = 0;

  while (processingInfo.state === "pending" || processingInfo.state === "in_progress") {
    const waitMs = Math.min(
      X_STATUS_MAX_INTERVAL_MS,
      Math.max(X_STATUS_MIN_INTERVAL_MS, (processingInfo.check_after_secs ?? 5) * 1000),
    );
    // Only start a wait + check that can finish before `stopBy`.
    if (remainingMs(stopBy) < waitMs + MIN_REQUEST_WINDOW_MS) {
      console.warn("[X OAuth 1.0a] Video still processing when the wait budget ran out", {
        mediaId,
        checks,
        state: processingInfo.state,
      });
      throw xProcessingTimeoutError();
    }
    console.log(`[X OAuth 1.0a] Video processing (${processingInfo.state}), waiting ${waitMs}ms... (check ${checks + 1})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // Check STATUS
    const statusData = {
      url: uploadUrl,
      method: "GET",
      data: {
        command: "STATUS",
        media_id: mediaId,
      },
    };

    const statusAuthHeader = oauth.toHeader(oauth.authorize(statusData, token));
    const statusUrl = `${uploadUrl}?${new URLSearchParams(statusData.data)}`;

    const statusResponse = await fetchWithTimeout(
      statusUrl,
      {
        method: "GET",
        headers: {
          ...statusAuthHeader,
        },
      },
      Math.min(X_STATUS_TIMEOUT_MS, Math.max(remainingMs(stopBy), MIN_REQUEST_WINDOW_MS)),
    );
    checks++;

    const statusLimited = await classifyRateLimit("x", statusResponse);
    if (statusLimited) throw statusLimited;

    await assertOk(statusResponse, {
      code: "X_VIDEO_STATUS_CHECK_FAILED",
      prefix: "X video processing status check failed",
    });

    const statusResult = (await statusResponse.json()) as {
      processing_info?: {
        state: string;
        check_after_secs?: number;
        progress_percent?: number;
        error?: { message: string; code: number };
      };
    };

    if (!statusResult.processing_info) {
      // No processing info means it's ready
      console.log("[X OAuth 1.0a] Video processing complete!");
      return;
    }

    processingInfo = statusResult.processing_info;

    if (processingInfo.error || processingInfo.state === "failed") {
      // COR-3: processingInfo.error.message is upstream-controlled content;
      // log it server-side but never surface it via PostJobResult.errorMessage.
      console.error("[X OAuth 1.0a] Video processing reported an error", {
        state: processingInfo.state,
        processingError: processingInfo.error,
      });
      throw xProcessingFailedError();
    }

    if (processingInfo.state === "succeeded") {
      console.log("[X OAuth 1.0a] Video processing succeeded!");
      return;
    }

    if (processingInfo.progress_percent !== undefined) {
      console.log(`[X OAuth 1.0a] Video processing progress: ${processingInfo.progress_percent}%`);
    }
  }
}

export const xClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption, deadline } = ctx;

    const accessToken = socialConnection.accessToken;
    const accessTokenSecret = socialConnection.refreshToken; // Stored as refreshToken
    const consumerKey = process.env.X_CONSUMER_KEY;
    const consumerSecret = process.env.X_CONSUMER_SECRET;

    console.log("[X OAuth 1.0a] Credentials check", {
      hasAccessToken: !!accessToken,
      hasAccessTokenSecret: !!accessTokenSecret,
      hasConsumerKey: !!consumerKey,
      hasConsumerSecret: !!consumerSecret,
      accessTokenLength: accessToken?.length,
      accessTokenSecretLength: accessTokenSecret?.length,
    });

    if (!accessToken || !accessTokenSecret) {
      const error = new Error("Missing access token for X") as Error & { code: string };
      error.code = "X_NO_ACCESS_TOKEN";
      throw error;
    }

    if (!consumerKey || !consumerSecret) {
      const error = new Error("Missing X consumer credentials") as Error & { code: string };
      error.code = "X_NO_CONSUMER_KEYS";
      throw error;
    }

    // X supports both images and videos
    const isVideo = mediaItem.mimeType?.startsWith("video/");
    const isImage = mediaItem.mimeType?.startsWith("image/");

    if (!isVideo && !isImage) {
      const error = new Error("X only supports image and video uploads") as Error & { code: string };
      error.code = "X_INVALID_MEDIA_TYPE";
      throw error;
    }

    console.log("[X OAuth 1.0a] Starting post creation", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
      isVideo,
      isImage,
    });

    // Upload media first
    const mediaUrl = mediaItem.storageLocation;
    const mediaId = await uploadMedia(
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
      mediaUrl,
      mediaItem.mimeType || "",
      deadline,
    );

    // X tweet character limit is 280 (see lib/platformLimits.ts). If caption
    // is longer, we'll truncate with ellipsis.
    const tweetText = computeTweetText(caption);

    // Create tweet with media using API v2 (Free tier has access to v2 endpoints)
    console.log("[X OAuth 1.0a] Creating tweet with v2 API", {
      textLength: tweetText.length,
      mediaId,
    });

    // Create OAuth client
    const oauth = new OAuth({
      consumer: { key: consumerKey, secret: consumerSecret },
      signature_method: "HMAC-SHA1",
      hash_function(base_string, key) {
        return crypto.createHmac("sha1", key).update(base_string).digest("base64");
      },
    });

    const token = {
      key: accessToken,
      secret: accessTokenSecret,
    };

    // Try v1.1 API first (more reliable with OAuth 1.0a), fallback to v2
    // v1.1 statuses/update uses form data, v2 uses JSON
    const v1Url = "https://api.twitter.com/1.1/statuses/update.json";
    const v1Params = {
      status: tweetText,
      media_ids: mediaId,
    };

    const v1RequestData = {
      url: v1Url,
      method: "POST",
      data: v1Params,
    };

    // Generate OAuth authorization header with params included in signature
    const v1AuthHeader = oauth.toHeader(oauth.authorize(v1RequestData, token));

    console.log("[X OAuth 1.0a] Trying v1.1 statuses/update endpoint");

    // No assertOk here: a 4xx v1 response is an intentional fallback signal
    // (try the v2 endpoint next), not a terminal failure — see below.
    // Budget-checked before sending: an exhausted budget throws here, with
    // no tweet created (safe to retry).
    //
    // 2026-11-01 scale audit (jobs H6, Review Focus 5): v1.1 is a COMMIT call.
    // A 5xx, a timeout or a dropped connection after it was sent may already
    // have posted the tweet, so commitRequest throws PUBLISH_UNCONFIRMED and we
    // do NOT fall back to v2 (that would post it a second time). Only a
    // rejection the platform answered (4xx, 429) returns and falls back.
    const v1Response = await commitRequest("x", () =>
      fetchWithTimeout(
        v1Url,
        {
          method: "POST",
          headers: {
            ...v1AuthHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(v1Params),
        },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      ),
    );

    if (v1Response.ok) {
      const v1Result = (await v1Response.json()) as { id_str: string };
      console.log("[X OAuth 1.0a] Tweet created successfully via v1.1", {
        tweetId: v1Result.id_str,
      });
      return {
        externalPostId: v1Result.id_str,
      };
    }

    // v1.1 REJECTED the request (4xx/429; a 5xx never gets here), so nothing was
    // posted: try v2.
    const v1ErrorBody = await v1Response.text().catch(() => "");
    console.log("[X OAuth 1.0a] v1.1 failed, trying v2 API", {
      status: v1Response.status,
      error: v1ErrorBody,
    });

    const tweetUrl = "https://api.twitter.com/2/tweets";
    const tweetPayload = {
      text: tweetText,
      media: {
        media_ids: [mediaId],
      },
    };

    const requestData = {
      url: tweetUrl,
      method: "POST",
    };

    // Generate OAuth authorization header
    const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

    // v2 is a commit call too: 5xx / timeout / dropped connection after sending
    // is PUBLISH_UNCONFIRMED.
    const tweetResponse = await commitRequest("x", () =>
      fetchWithTimeout(
        tweetUrl,
        {
          method: "POST",
          headers: {
            ...authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(tweetPayload),
        },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      ),
    );

    // The v1.1 call above is deliberately NOT classified (any 4xx falls back to
    // v2). The v2 call is the last word: a 429 here is RATE_LIMITED, so the post
    // waits (commitRequest returns 429s untouched).
    const tweetLimited = await classifyRateLimit("x", tweetResponse);
    if (tweetLimited) throw tweetLimited;

    // v1Response's status/body are already logged above (line ~495); assertOk
    // additionally logs tweetResponse's own status + body server-side.
    await assertOk(tweetResponse, {
      code: "X_TWEET_FAILED",
      prefix: "X tweet creation failed",
    });

    const tweetResult = (await tweetResponse.json()) as {
      data: {
        id: string;
        text: string;
      };
    };

    console.log("[X OAuth 1.0a] Tweet created successfully", {
      tweetId: tweetResult.data.id,
      tweetUrl: `https://twitter.com/i/web/status/${tweetResult.data.id}`,
    });

    return {
      externalPostId: tweetResult.data.id,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
