import type { SocialConnection } from "@prisma/client";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { truncateGraphemes } from "@/lib/truncate";

// COR-2/COR-3: xClient uses oauth-1.0a request signing (see `oauth.authorize`
// calls below). fetchWithTimeout passes `init` through unchanged except for
// `signal` (see its docstring), so migrating `fetch(url, init)` calls here to
// `fetchWithTimeout(url, init, timeoutMs)` preserves the exact URL/method/
// headers/body the signature was computed over — only a composed abort
// signal is added, which the signature does not cover.

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
  mimeType: string
): Promise<string> {
  console.log("[X OAuth 1.0a] Starting media upload", { mediaUrl, mimeType });

  // Download media from Vercel Blob.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
  const mediaResponse = await fetchWithTimeout(
    mediaUrl,
    { signal: AbortSignal.timeout(120_000) },
    120_000,
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
    return await uploadVideoChunked(oauth, token, uploadUrl, mediaBuffer, mimeType);
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
    120_000,
  );

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
  mimeType: string
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
  const initResponse = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      ...initAuthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(initData.data),
  });

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
      120_000,
    );

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
  const finalizeResponse = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      ...finalizeAuthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(finalizeData.data),
  });

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
    await waitForVideoProcessing(oauth, token, uploadUrl, mediaId, finalizeResult.processing_info);
  }

  return finalizeResult.media_id_string;
}

/**
 * Poll STATUS endpoint until video processing is complete
 */
async function waitForVideoProcessing(
  oauth: OAuth,
  token: { key: string; secret: string },
  uploadUrl: string,
  mediaId: string,
  initialProcessingInfo: { state: string; check_after_secs?: number }
): Promise<void> {
  let processingInfo: {
    state: string;
    check_after_secs?: number;
    progress_percent?: number;
    error?: { message: string; code: number };
  } = initialProcessingInfo;
  let attempts = 0;
  const maxAttempts = 60; // Max 5 minutes (60 * 5s average)

  while (
    (processingInfo.state === "pending" || processingInfo.state === "in_progress") &&
    attempts < maxAttempts
  ) {
    const checkAfter = processingInfo.check_after_secs || 5;
    console.log(`[X OAuth 1.0a] Video processing (${processingInfo.state}), waiting ${checkAfter}s... (attempt ${attempts + 1}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, checkAfter * 1000));

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
    
    const statusResponse = await fetchWithTimeout(statusUrl, {
      method: "GET",
      headers: {
        ...statusAuthHeader,
      },
    });

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

    if (processingInfo.error) {
      // COR-3: processingInfo.error.message is upstream-controlled content;
      // log it server-side but never surface it via PostJobResult.errorMessage.
      console.error("[X OAuth 1.0a] Video processing reported an error", {
        processingError: processingInfo.error,
      });
      const error = new Error(
        "X reported an error while processing the uploaded video",
      ) as Error & { code: string };
      error.code = "X_VIDEO_PROCESSING_FAILED";
      throw error;
    }

    if (processingInfo.state === "succeeded") {
      console.log("[X OAuth 1.0a] Video processing succeeded!");
      return;
    }

    if (processingInfo.progress_percent !== undefined) {
      console.log(`[X OAuth 1.0a] Video processing progress: ${processingInfo.progress_percent}%`);
    }

    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error("Video processing timed out after 5 minutes");
  }
}

export const xClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

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
      mediaItem.mimeType || ""
    );

    // X tweet character limit is 280
    // If caption is longer, we'll truncate with ellipsis
    let tweetText = caption;
    if (tweetText.length > 280) {
      tweetText = truncateGraphemes(tweetText, 280, { ellipsis: "..." });
      console.log("[X OAuth 1.0a] Caption truncated to 280 characters");
    }

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

    // No assertOk here: a !ok v1 response is an intentional fallback signal
    // (try the v2 endpoint next), not a terminal failure — see below.
    const v1Response = await fetchWithTimeout(v1Url, {
      method: "POST",
      headers: {
        ...v1AuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(v1Params),
    });

    if (v1Response.ok) {
      const v1Result = (await v1Response.json()) as { id_str: string };
      console.log("[X OAuth 1.0a] Tweet created successfully via v1.1", {
        tweetId: v1Result.id_str,
      });
      return {
        externalPostId: v1Result.id_str,
      };
    }

    // If v1.1 fails, try v2 API
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

    const tweetResponse = await fetchWithTimeout(tweetUrl, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tweetPayload),
    });

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
