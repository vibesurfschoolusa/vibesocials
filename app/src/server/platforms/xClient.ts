import type { SocialConnection } from "@prisma/client";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";

import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import {
  isTransientUploadFailure,
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  openBlobChunkStream,
  usesLargeUploadPath,
  type BlobChunkStream,
} from "./largeUpload";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { classifyRateLimit, isRateLimitedError } from "./rateLimited";

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

// 2026-11-02 scale audit (jobs B3, M3): a video above LARGE_VIDEO_THRESHOLD_BYTES
// (largeUpload.ts) on a platform listed in LARGE_UPLOAD_PLATFORMS is read from storage one
// segment at a time and sent across steps, and X's processing of it is awaited across steps
// too. It keeps the endpoint and encoding the small path has always used: the v1.1 media
// endpoint with OAuth 1.0a, `media_data` base64 in a signed form body.

/** The v1.1 media endpoint, for both paths. */
const X_MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";

/**
 * Raw bytes per APPEND segment (5 MiB); the request carries them base64-encoded. X recommends
 * segments of at most 5 MB and accepts up to 8 MB (v2 media docs:
 * https://docs.x.com/x-api/media/quickstart/media-upload-chunked). This client uses the v1.1
 * endpoint, whose limits could not be confirmed from X's documentation (unconfirmed), so the
 * size stays at the 5 MiB that works in production. One request holds the segment (5 MiB), its
 * base64 form (about 6.7 MB) and the signed form strings: about 30 MB in all.
 */
export const X_APPEND_SEGMENT_BYTES = 5_242_880;

/**
 * How long a media id is assumed to stay usable when INIT does not say (`expires_after_secs`).
 * The v2 docs show 86400 in the INIT and FINALIZE answers
 * (https://docs.x.com/x-api/media/quickstart/media-upload-chunked); the v1.1 answer could not
 * be confirmed (unconfirmed), so an hour is assumed.
 */
export const X_DEFAULT_MEDIA_EXPIRES_SECS = 3_600;

/**
 * A media id with less than this left is not tweeted: the upload starts over from INIT
 * instead. Our own safety margin (nothing has been tweeted yet when it applies).
 */
export const X_MEDIA_EXPIRY_SAFETY_MS = 600_000;

/**
 * How long after FINALIZE a chunked upload waits for X to finish processing (20 min) before
 * X_VIDEO_PROCESSING_TIMEOUT. Our own bound: the docs give no maximum. The small path keeps
 * its 120 s cap (X_PROCESSING_MAX_WAIT_MS).
 */
export const X_LARGE_PROCESSING_MAX_MS = 1_200_000;

/** The wait between two STATUS checks of a chunked upload is `check_after_secs`, clamped to this range. */
export const X_LARGE_STATUS_MIN_INTERVAL_MS = 5_000;
export const X_LARGE_STATUS_MAX_INTERVAL_MS = 60_000;

/**
 * When a request that commits nothing (APPEND, FINALIZE, STATUS) gets no usable answer, the
 * step saves its place and the next one starts this long after: a short pause, so an outage
 * does not burn the continuations (platformSteps.ts) in a few seconds.
 */
export const X_TRANSIENT_RESUME_DELAY_MS = 30_000;

/** The tweet (the commit call) starts only with this much of the step left; else the step continues at once. */
export const X_TWEET_MIN_WINDOW_MS = X_TWEET_RESERVE_MS + 10_000;

/** A segment or FINALIZE that got no usable answer is retried once, in the next step; the second failure is final. */
const X_MAX_REQUEST_RETRIES = 1;

/**
 * The `kind` of a chunked X upload in the saved upload state (uploadState.ts). Its `data`
 * is progress and ids only: each request is signed afresh, so nothing in it is secret and no
 * OAuth credential may ever be put in it.
 */
export const X_UPLOAD_STATE_KIND = "x_chunked";

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
 *
 * CHUNKED PATH (2026-11-02 scale audit, jobs B3/M3). One step of a video above 50 MiB:
 *
 *   INIT / FINALIZE   once per upload; each <= min(30s, time left)
 *   APPEND            each <= min(120s, time left), only started with >= 60s left
 *                     (LARGE_UPLOAD_CHUNK_WINDOW_MS); then the step saves and continues
 *   STATUS            a wait of check_after_secs (5-60s) and a check (<= 15s) are only
 *                     started with X_TWEET_RESERVE_MS left after them; else the step saves
 *                     and continues after the wait
 *   tweet             the commit call (v1.1, then v2): only with >= X_TWEET_MIN_WINDOW_MS
 *                     left, and always inside the same step as the status check before it
 *
 * Nothing but the tweet publishes anything, so every pause is safe to resume.
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

type XToken = { key: string; secret: string };

/** The OAuth 1.0a signer every X request goes through: HMAC-SHA1 over the consumer and token secrets. */
function createOAuth(consumerKey: string, consumerSecret: string): OAuth {
  return new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base_string, key) {
      return crypto.createHmac("sha1", key).update(base_string).digest("base64");
    },
  });
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
  const oauth = createOAuth(consumerKey, consumerSecret);

  const token = {
    key: accessToken,
    secret: accessTokenSecret,
  };

  const uploadUrl = X_MEDIA_UPLOAD_URL;
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
  const chunkSize = X_APPEND_SEGMENT_BYTES; // 5 MiB chunks

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

/**
 * Create the tweet with the uploaded media: the COMMIT call, shared by the small and the
 * chunked path. v1.1 `statuses/update` first, then a v2 fallback; no v2 after an ambiguous
 * v1.1 (see below). A 429 on v2 is RATE_LIMITED; the caller decides what that means for its
 * saved state.
 */
async function postTweet(args: {
  oauth: OAuth;
  token: XToken;
  tweetText: string;
  mediaId: string;
  deadline: number | undefined;
}): Promise<PublishResult> {
  const { oauth, token, tweetText, mediaId, deadline } = args;

  // Create tweet with media using API v2 (Free tier has access to v2 endpoints)
  console.log("[X OAuth 1.0a] Creating tweet with v2 API", {
    textLength: tweetText.length,
    mediaId,
  });

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
    // v1.1 answered 2xx, so the tweet may be live: an unreadable body is
    // PUBLISH_UNCONFIRMED, and we do not fall back to v2 (final review F4). So is
    // a body that parsed but has no `id_str` (2026-11-02 scale audit).
    const v1Result = await readCommitBody<{ id_str?: unknown } | null>("x", v1Response, "json");
    const v1TweetId = requireCommitId("x", v1Result?.id_str, "id_str");
    console.log("[X OAuth 1.0a] Tweet created successfully via v1.1", {
      tweetId: v1TweetId,
    });
    return {
      externalPostId: v1TweetId,
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
  // waits (commitRequest returns 429s untouched). classifyRateLimit looks at 429
  // only: a 2xx answer that carries x-rate-limit-* headers is still a success.
  const tweetLimited = await classifyRateLimit("x", tweetResponse);
  if (tweetLimited) throw tweetLimited;

  // v1Response's status/body are already logged above; assertOk
  // additionally logs tweetResponse's own status + body server-side.
  await assertOk(tweetResponse, {
    code: "X_TWEET_FAILED",
    prefix: "X tweet creation failed",
  });

  // v2 answered 2xx, so the tweet may be live: an unreadable body is
  // PUBLISH_UNCONFIRMED (final review F4), and so is a body that parsed but has
  // no `data.id` (2026-11-02 scale audit).
  const tweetResult = await readCommitBody<{
    data?: { id?: unknown; text?: string } | null;
  } | null>("x", tweetResponse, "json");
  const tweetId = requireCommitId("x", tweetResult?.data?.id, "data.id");

  console.log("[X OAuth 1.0a] Tweet created successfully", {
    tweetId,
    tweetUrl: `https://twitter.com/i/web/status/${tweetId}`,
  });

  return {
    externalPostId: tweetId,
  };
}

// ---------------------------------------------------------------------------
// Chunked path (2026-11-02 scale audit, jobs B3/M3)
// ---------------------------------------------------------------------------

/** Where a chunked upload stands between two steps. */
interface XChunkedData {
  mediaId: string;
  totalBytes: number;
  /** Index of the next segment to send; the segment count once every segment is in. */
  nextSegment: number;
  /**
   * append: segments (and then FINALIZE) are still to do. processing: FINALIZE answered and X
   * is still processing the video. ready: X finished; only the tweet is left.
   */
  phase: "append" | "processing" | "ready";
  /** Epoch ms at which INIT's media id stops being usable. */
  expiresAt: number;
  /** Epoch ms FINALIZE answered; set from FINALIZE on. */
  finalizedAt?: number;
  /** Failed tries of the request in progress (a segment, then FINALIZE); 0 after it went through. */
  failedSegmentRetries: number;
}

/** The `processing_info` of a FINALIZE or STATUS answer (only the fields we read). */
interface XProcessingInfo {
  state?: string;
  check_after_secs?: number;
  progress_percent?: number;
  error?: { message?: string; code?: number };
}

type ProcessingVerdict = { kind: "ready" } | { kind: "waiting"; checkAfterSecs: number | undefined };

function xUploadError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function segmentCount(totalBytes: number): number {
  return Math.ceil(totalBytes / X_APPEND_SEGMENT_BYTES);
}

function isNearExpiry(upload: XChunkedData): boolean {
  return upload.expiresAt - Date.now() < X_MEDIA_EXPIRY_SAFETY_MS;
}

/**
 * The saved upload, if it can be used for a video of `totalBytes`: its id, position, phase and
 * times must be coherent. Anything else (another size, a bad position, a processing phase with
 * segments missing) is treated as no state, and the upload starts over.
 */
function readSavedUpload(
  saved: UploadSnapshot<Partial<XChunkedData>> | null,
  totalBytes: number,
): XChunkedData | null {
  const data = saved?.data;
  if (typeof data !== "object" || data === null) return null;
  const { mediaId, nextSegment, phase, expiresAt, finalizedAt, failedSegmentRetries } = data;
  const segments = segmentCount(totalBytes);

  if (typeof mediaId !== "string" || mediaId === "") return null;
  if (data.totalBytes !== totalBytes) return null;
  if (typeof nextSegment !== "number" || !Number.isInteger(nextSegment)) return null;
  if (nextSegment < 0 || nextSegment > segments) return null;
  if (phase !== "append" && phase !== "processing" && phase !== "ready") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (typeof failedSegmentRetries !== "number" || !Number.isInteger(failedSegmentRetries)) return null;
  if (failedSegmentRetries < 0) return null;
  if (phase !== "append") {
    // FINALIZE comes after the last segment, and stamps its time.
    if (nextSegment !== segments) return null;
    if (typeof finalizedAt !== "number" || !Number.isFinite(finalizedAt)) return null;
  }
  return {
    mediaId,
    totalBytes,
    nextSegment,
    phase,
    expiresAt,
    ...(typeof finalizedAt === "number" && Number.isFinite(finalizedAt) ? { finalizedAt } : {}),
    failedSegmentRetries,
  };
}

/**
 * Send a request that commits nothing and sort what comes back: a 429 is RATE_LIMITED
 * (thrown), a 5xx is a failure that carries its `status`, an error from the request itself is
 * a failure, anything else is the response for the caller to read. `send` is called once.
 */
async function attemptRequest(
  send: () => Promise<Response>,
): Promise<{ response: Response } | { failure: unknown }> {
  let response: Response;
  try {
    response = await send();
  } catch (failure) {
    return { failure };
  }
  const limited = await classifyRateLimit("x", response);
  if (limited) throw limited;
  if (response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    return { failure: Object.assign(new Error(`X answered HTTP ${response.status}`), { status: response.status }) };
  }
  return { response };
}

/** The body of a 2xx answer, or a coded failure (never X's own text). */
async function readJsonBody<T>(response: Response, code: string, message: string): Promise<T | null> {
  try {
    return (await response.json()) as T | null;
  } catch {
    throw xUploadError(code, `${message}: X's answer could not be read`);
  }
}

/** A signed form POST to the media endpoint (INIT, APPEND, FINALIZE). `timeoutMs` is already budgeted. */
function postMediaCommand(args: {
  oauth: OAuth;
  token: XToken;
  data: Record<string, string>;
  timeoutMs: number;
}): Promise<Response> {
  const { oauth, token, data, timeoutMs } = args;
  const authHeader = oauth.toHeader(oauth.authorize({ url: X_MEDIA_UPLOAD_URL, method: "POST", data }, token));
  return fetchWithTimeout(
    X_MEDIA_UPLOAD_URL,
    {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data),
    },
    timeoutMs,
  );
}

/** A signed STATUS check. `timeoutMs` is already budgeted. */
function getMediaStatus(args: {
  oauth: OAuth;
  token: XToken;
  mediaId: string;
  timeoutMs: number;
}): Promise<Response> {
  const { oauth, token, mediaId, timeoutMs } = args;
  const data = { command: "STATUS", media_id: mediaId };
  const authHeader = oauth.toHeader(oauth.authorize({ url: X_MEDIA_UPLOAD_URL, method: "GET", data }, token));
  return fetchWithTimeout(
    `${X_MEDIA_UPLOAD_URL}?${new URLSearchParams(data)}`,
    { method: "GET", headers: { ...authHeader } },
    timeoutMs,
  );
}

/**
 * INIT: a new media id for `totalBytes`, and when it stops being usable (`expires_after_secs`,
 * else {@link X_DEFAULT_MEDIA_EXPIRES_SECS}). Not the commit call: a failure here posts nothing.
 */
async function initChunkedMedia(args: {
  oauth: OAuth;
  token: XToken;
  totalBytes: number;
  mimeType: string;
  deadline: number | undefined;
}): Promise<{ mediaId: string; expiresAt: number }> {
  const { oauth, token, totalBytes, mimeType, deadline } = args;
  const response = await postMediaCommand({
    oauth,
    token,
    data: {
      command: "INIT",
      total_bytes: totalBytes.toString(),
      media_type: mimeType,
      media_category: "tweet_video",
    },
    timeoutMs: budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  });

  const limited = await classifyRateLimit("x", response);
  if (limited) throw limited;

  await assertOk(response, {
    code: "X_VIDEO_INIT_FAILED",
    prefix: "X video upload initialization failed",
  });

  const result = await readJsonBody<{ media_id_string?: unknown; expires_after_secs?: unknown }>(
    response,
    "X_VIDEO_INIT_FAILED",
    "X video upload initialization failed",
  );
  const mediaId = result?.media_id_string;
  if (typeof mediaId !== "string" || mediaId === "") {
    throw xUploadError("X_VIDEO_INIT_FAILED", "X video upload initialization failed: X returned no media id");
  }
  const said = result?.expires_after_secs;
  const expiresAfterSecs =
    typeof said === "number" && Number.isFinite(said) && said > 0 ? said : X_DEFAULT_MEDIA_EXPIRES_SECS;
  return { mediaId, expiresAt: Date.now() + expiresAfterSecs * 1000 };
}

/**
 * What a FINALIZE or STATUS answer says about processing. No `processing_info` or
 * `succeeded` is ready; `failed` (or an error object) is X_VIDEO_PROCESSING_FAILED; anything
 * else, a state we do not know included, is still processing: nothing is tweeted until X says
 * it succeeded.
 */
function judgeProcessing(info: XProcessingInfo | null | undefined): ProcessingVerdict {
  if (!info) return { kind: "ready" };
  if (info.error || info.state === "failed") {
    // COR-3: info.error.message is upstream-controlled content; log it server-side but never
    // surface it via PostJobResult.errorMessage.
    console.error("[X OAuth 1.0a] Video processing reported an error", {
      state: info.state,
      processingError: info.error,
    });
    throw xProcessingFailedError();
  }
  if (info.state === "succeeded") return { kind: "ready" };
  return {
    kind: "waiting",
    checkAfterSecs: typeof info.check_after_secs === "number" ? info.check_after_secs : undefined,
  };
}

/** X's `check_after_secs` clamped to [X_LARGE_STATUS_MIN_INTERVAL_MS, X_LARGE_STATUS_MAX_INTERVAL_MS]. */
function statusWaitMs(checkAfterSecs: number | undefined): number {
  const wanted =
    typeof checkAfterSecs === "number" && Number.isFinite(checkAfterSecs)
      ? checkAfterSecs * 1000
      : X_LARGE_STATUS_MIN_INTERVAL_MS;
  return Math.min(X_LARGE_STATUS_MAX_INTERVAL_MS, Math.max(X_LARGE_STATUS_MIN_INTERVAL_MS, wanted));
}

/**
 * One step of a chunked upload (2026-11-02 scale audit, jobs B3/M3). Whether to start an upload
 * or resume one is decided by `resumed` alone - the state `load()` returned - and never by
 * `ctx.continuation`: if a step's output is lost after it continued, the same step number runs
 * again with the state already there and must resume, not INIT a second media.
 *
 * Phases, each saved before the step moves on:
 * - none: INIT, saved at once (before the first segment).
 * - append: segments from `nextSegment`, read from the blob with one Range request, while at
 *   least LARGE_UPLOAD_CHUNK_WINDOW_MS of the step is left; then FINALIZE, once.
 * - processing: STATUS, polled in the step while the budget leaves room for a wait, a check
 *   and X_TWEET_RESERVE_MS; else the step continues after the wait. Over
 *   X_LARGE_PROCESSING_MAX_MS since FINALIZE: X_VIDEO_PROCESSING_TIMEOUT.
 * - ready: the tweet, with at least X_TWEET_MIN_WINDOW_MS left, else an immediate continuation.
 *
 * A media id with less than X_MEDIA_EXPIRY_SAFETY_MS left is dropped and the video is uploaded
 * again from INIT (nothing has been tweeted). A segment or FINALIZE that gets no usable answer
 * is tried once more in the next step, then fails. A 429 saves the position, then throws
 * RATE_LIMITED. Running into the step deadline pauses; it never fails the upload.
 */
async function publishChunked(args: {
  ctx: PublishContext;
  oauth: OAuth;
  token: XToken;
  store: UploadStateStore;
  resumed: XChunkedData | null;
  caption: string;
}): Promise<PublishResult> {
  const { ctx, oauth, token, store, resumed, caption } = args;
  const { mediaItem, deadline } = ctx;
  const totalBytes = mediaItem.sizeBytes;
  const mimeType = mediaItem.mimeType || "";
  const totalSegments = segmentCount(totalBytes);

  const save = (data: XChunkedData) => store.save<XChunkedData>(X_UPLOAD_STATE_KIND, { data });

  const beginUpload = async (): Promise<XChunkedData> => {
    const { mediaId, expiresAt } = await initChunkedMedia({ oauth, token, totalBytes, mimeType, deadline });
    const fresh: XChunkedData = {
      mediaId,
      totalBytes,
      nextSegment: 0,
      phase: "append",
      expiresAt,
      failedSegmentRetries: 0,
    };
    await save(fresh);
    console.log("[X OAuth 1.0a] Chunked video upload started", { mediaId, totalBytes, segments: totalSegments });
    return fresh;
  };

  let current: XChunkedData = resumed ?? (await beginUpload());
  // A media id this very step created is not checked for expiry again: no loop on a short-lived id.
  let startedHere = resumed === null;
  // What FINALIZE just said, so the same step does not ask STATUS straight after it.
  let freshVerdict: ProcessingVerdict | null = null;
  // The old media's state is gone and its replacement is not saved yet.
  let stateCleared = false;
  // Held in an object so the finally block sees the stream a closure opened.
  const source: { stream: BlobChunkStream | null } = { stream: null };

  const closeSource = async () => {
    const stream = source.stream;
    source.stream = null;
    await stream?.close();
  };

  /** Save and hand the claim back: the run calls this client again, no sooner than `delayMs` from now. */
  const pause = async (delayMs: number | null): Promise<PublishResult> => {
    await save(current);
    console.log("[X OAuth 1.0a] Chunked upload continues in another step", {
      phase: current.phase,
      nextSegment: current.nextSegment,
      totalSegments,
    });
    return { continuation: { resumeAt: delayMs === null ? null : Date.now() + delayMs } };
  };

  /** The media id is about to expire. Nothing was tweeted: forget it and upload the video again. */
  const restartExpired = async () => {
    console.warn("[X OAuth 1.0a] The uploaded media is about to expire; uploading the video again", {
      phase: current.phase,
    });
    await closeSource();
    await store.clear();
    stateCleared = true;
    current = await beginUpload();
    stateCleared = false;
    startedHere = true;
    freshVerdict = null;
  };

  /** The next `length` bytes of the video from `offset` (one open stream, read in order). */
  const readSegment = async (offset: number, length: number): Promise<Buffer> => {
    if (source.stream !== null && source.stream.position !== offset) await closeSource();
    source.stream ??= await openBlobChunkStream(mediaItem.storageLocation, { offset, totalBytes, deadline });
    return await source.stream.read(length);
  };

  /**
   * A request that commits nothing got no usable answer. A failure that is not transient
   * surfaces. Out of time for another request: pause, which is not a failure of the upload. Else
   * it is tried once more in the next step, a little later; the second failure is final.
   */
  const retryOrFail = async (failure: unknown, exhausted: () => Error): Promise<PublishResult> => {
    if (!isTransientUploadFailure(failure)) throw failure;
    const answered = typeof (failure as { status?: unknown } | null)?.status === "number";
    if (!answered && remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
    if (current.failedSegmentRetries >= X_MAX_REQUEST_RETRIES) throw exhausted();
    current = { ...current, failedSegmentRetries: current.failedSegmentRetries + 1 };
    console.warn("[X OAuth 1.0a] A request got no usable answer; the next step tries it again", {
      phase: current.phase,
      nextSegment: current.nextSegment,
      status: (failure as { status?: unknown } | null)?.status,
      code: (failure as { code?: unknown } | null)?.code,
    });
    return await pause(X_TRANSIENT_RESUME_DELAY_MS);
  };

  /**
   * STATUS. It only reads, so asking again is always safe: a transient failure (no answer, or an
   * answer whose body drops) pauses the step, until the processing cap ends the wait.
   */
  const checkStatus = async (): Promise<{ verdict: ProcessingVerdict } | { paused: PublishResult }> => {
    const unanswered = async (failure: unknown): Promise<{ paused: PublishResult }> => {
      if (Date.now() - (current.finalizedAt ?? Date.now()) >= X_LARGE_PROCESSING_MAX_MS) {
        throw xProcessingTimeoutError();
      }
      console.warn("[X OAuth 1.0a] The status check got no answer; the next step asks again", {
        status: (failure as { status?: unknown } | null)?.status,
        code: (failure as { code?: unknown } | null)?.code,
      });
      return { paused: await pause(X_TRANSIENT_RESUME_DELAY_MS) };
    };

    const attempt = await attemptRequest(() =>
      getMediaStatus({
        oauth,
        token,
        mediaId: current.mediaId,
        timeoutMs: budgetedTimeout(X_STATUS_TIMEOUT_MS, deadline),
      }),
    );
    if ("failure" in attempt) {
      if (!isTransientUploadFailure(attempt.failure)) throw attempt.failure;
      return await unanswered(attempt.failure);
    }

    await assertOk(attempt.response, {
      code: "X_VIDEO_STATUS_CHECK_FAILED",
      prefix: "X video processing status check failed",
    });
    let body: { processing_info?: XProcessingInfo } | null;
    try {
      body = (await attempt.response.json()) as { processing_info?: XProcessingInfo } | null;
    } catch (error) {
      if (isTransientUploadFailure(error)) return await unanswered(error);
      throw xUploadError(
        "X_VIDEO_STATUS_CHECK_FAILED",
        "X video processing status check failed: X's answer could not be read",
      );
    }
    return { verdict: judgeProcessing(body?.processing_info) };
  };

  try {
    if (!startedHere && isNearExpiry(current)) await restartExpired();

    for (;;) {
      if (current.phase === "append") {
        while (current.nextSegment < totalSegments) {
          if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);

          const index = current.nextSegment;
          const offset = index * X_APPEND_SEGMENT_BYTES;
          const length = Math.min(X_APPEND_SEGMENT_BYTES, totalBytes - offset);

          let segment: Buffer;
          try {
            segment = await readSegment(offset, length);
          } catch (error) {
            // Reading runs into the deadline: nothing was sent, so this is not a failure of the
            // upload. The next step reopens the blob at the same segment.
            if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
            throw error;
          }
          // Reading takes time too: the segment must still fit.
          if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);

          const mediaId = current.mediaId;
          const attempt = await attemptRequest(() =>
            postMediaCommand({
              oauth,
              token,
              data: {
                command: "APPEND",
                media_id: mediaId,
                segment_index: index.toString(),
                media_data: segment.toString("base64"),
              },
              timeoutMs: budgetedTimeout(X_UPLOAD_TIMEOUT_MS, deadline),
            }),
          );
          if ("failure" in attempt) {
            return await retryOrFail(attempt.failure, () =>
              xUploadError(
                "X_VIDEO_APPEND_FAILED",
                `X video APPEND failed (segment ${index}): no usable answer after a retry`,
              ),
            );
          }

          await assertOk(attempt.response, {
            code: "X_VIDEO_APPEND_FAILED",
            prefix: `X video APPEND failed (segment ${index})`,
          });
          void attempt.response.body?.cancel().catch(() => {});
          current = { ...current, nextSegment: index + 1, failedSegmentRetries: 0 };
          await save(current);
          console.log("[X OAuth 1.0a] Segment uploaded", { segment: index + 1, totalSegments });
        }

        await closeSource();
        console.log("[X OAuth 1.0a] All segments uploaded, finalizing...");

        // FINALIZE, once. A request that is not the commit call starts with a full window left.
        if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
        const finalizeMediaId = current.mediaId;
        const attempt = await attemptRequest(() =>
          postMediaCommand({
            oauth,
            token,
            data: { command: "FINALIZE", media_id: finalizeMediaId },
            timeoutMs: budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
          }),
        );
        if ("failure" in attempt) {
          return await retryOrFail(attempt.failure, () =>
            xUploadError(
              "X_VIDEO_FINALIZE_FAILED",
              "X video upload finalization failed: no usable answer after a retry",
            ),
          );
        }
        await assertOk(attempt.response, {
          code: "X_VIDEO_FINALIZE_FAILED",
          prefix: "X video upload finalization failed",
        });
        const finalized = await readJsonBody<{ processing_info?: XProcessingInfo }>(
          attempt.response,
          "X_VIDEO_FINALIZE_FAILED",
          "X video upload finalization failed",
        );
        const verdict = judgeProcessing(finalized?.processing_info);
        console.log("[X OAuth 1.0a] Video upload finalized", {
          mediaId: current.mediaId,
          processingInfo: finalized?.processing_info,
        });
        current = {
          ...current,
          phase: verdict.kind === "ready" ? "ready" : "processing",
          finalizedAt: Date.now(),
          failedSegmentRetries: 0,
        };
        await save(current);
        freshVerdict = verdict;
        continue;
      }

      if (current.phase === "processing") {
        let verdict: ProcessingVerdict | null = freshVerdict;
        freshVerdict = null;
        for (;;) {
          if (verdict === null) {
            const checked = await checkStatus();
            if ("paused" in checked) return checked.paused;
            verdict = checked.verdict;
          }
          if (verdict.kind === "ready") break;

          if (Date.now() - (current.finalizedAt ?? Date.now()) >= X_LARGE_PROCESSING_MAX_MS) {
            console.warn("[X OAuth 1.0a] Video still processing when the wait for it ran out", {
              mediaId: current.mediaId,
            });
            throw xProcessingTimeoutError();
          }
          // Wait here only while the step has room for the wait, a check and the tweet reserve.
          const waitMs = statusWaitMs(verdict.checkAfterSecs);
          if (remainingMs(deadline) < waitMs + X_STATUS_TIMEOUT_MS + X_TWEET_RESERVE_MS) {
            return await pause(waitMs);
          }
          console.log(`[X OAuth 1.0a] Video processing, waiting ${waitMs}ms...`);
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          verdict = null;
        }
        console.log("[X OAuth 1.0a] Video processing complete!");
        current = { ...current, phase: "ready" };
        await save(current);
        continue;
      }

      // ready: only the tweet is left.
      if (!startedHere && isNearExpiry(current)) {
        await restartExpired();
        continue;
      }
      if (remainingMs(deadline) < X_TWEET_MIN_WINDOW_MS) return await pause(null);
      return await postTweet({
        oauth,
        token,
        tweetText: computeTweetText(caption),
        mediaId: current.mediaId,
        deadline,
      });
    }
  } catch (error) {
    if (isRateLimitedError(error) && !stateCleared) {
      // The deferral resumes from here. Best effort: a failed save must not hide the rate limit.
      // (Not when the expired media's state was just dropped: the deferral starts over from INIT.)
      await save(current).catch((saveError: unknown) => {
        console.warn("[X OAuth 1.0a] Could not save the upload progress before the rate-limit wait", {
          code: (saveError as { code?: unknown } | null)?.code,
        });
      });
    }
    throw error;
  } finally {
    await closeSource();
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

    // 2026-11-02 scale audit (jobs B3, M3): a video above 50 MiB on a platform enabled in
    // LARGE_UPLOAD_PLATFORMS - or any upload that already has saved state - is streamed from
    // storage in segments across steps; everything else keeps the whole-file upload below,
    // unchanged. The saved state alone decides whether this step starts an upload or resumes
    // one (never `ctx.continuation`), so it is read before anything is uploaded.
    const store = ctx.uploadState;
    const totalBytes = mediaItem.sizeBytes;
    const sizeIsUsable = Number.isSafeInteger(totalBytes) && totalBytes > 0;
    const saved =
      store !== undefined && isVideo && sizeIsUsable
        ? await store.load<Partial<XChunkedData>>(X_UPLOAD_STATE_KIND)
        : null;
    const resumed = readSavedUpload(saved, totalBytes);
    if (saved !== null && resumed === null) {
      console.warn("[X OAuth 1.0a] The saved upload cannot be used; a new upload starts", { size: totalBytes });
    }
    const chunked =
      store !== undefined &&
      isVideo &&
      sizeIsUsable &&
      usesLargeUploadPath({
        platform: "x",
        mimeType: mediaItem.mimeType || "",
        sizeBytes: totalBytes,
        hasState: resumed !== null,
        hasStore: true,
      });

    // Create OAuth client
    const oauth = createOAuth(consumerKey, consumerSecret);
    const token = {
      key: accessToken,
      secret: accessTokenSecret,
    };

    if (store !== undefined && chunked) {
      return publishChunked({ ctx, oauth, token, store, resumed, caption });
    }

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

    return postTweet({ oauth, token, tweetText, mediaId, deadline });
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
