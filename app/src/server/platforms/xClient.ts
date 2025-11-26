import type { SocialConnection } from "@prisma/client";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

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

  // Download media from Vercel Blob
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error("Failed to fetch media from storage");
  }

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

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      media_data: mediaBase64,
    }),
  });

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text().catch(() => "Unable to read error");
    console.error("[X OAuth 1.0a] Media upload failed", {
      status: uploadResponse.status,
      errorBody,
    });
    throw new Error(`X media upload failed: ${errorBody}`);
  }

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
  const initResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...initAuthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(initData.data),
  });

  if (!initResponse.ok) {
    const errorBody = await initResponse.text().catch(() => "Unable to read error");
    console.error("[X OAuth 1.0a] Video INIT failed", {
      status: initResponse.status,
      errorBody,
    });
    throw new Error(`X video INIT failed: ${errorBody}`);
  }

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
    const appendResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...appendAuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(appendData.data),
    });

    if (!appendResponse.ok) {
      const errorBody = await appendResponse.text().catch(() => "Unable to read error");
      console.error("[X OAuth 1.0a] Video APPEND failed", {
        segmentIndex,
        status: appendResponse.status,
        errorBody,
      });
      throw new Error(`X video APPEND failed: ${errorBody}`);
    }

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
  const finalizeResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...finalizeAuthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(finalizeData.data),
  });

  if (!finalizeResponse.ok) {
    const errorBody = await finalizeResponse.text().catch(() => "Unable to read error");
    console.error("[X OAuth 1.0a] Video FINALIZE failed", {
      status: finalizeResponse.status,
      errorBody,
    });
    throw new Error(`X video FINALIZE failed: ${errorBody}`);
  }

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

  // If video is still processing, wait for it
  if (finalizeResult.processing_info?.state === "pending" || finalizeResult.processing_info?.state === "in_progress") {
    const checkAfter = finalizeResult.processing_info.check_after_secs || 5;
    console.log(`[X OAuth 1.0a] Video processing, waiting ${checkAfter}s...`);
    await new Promise((resolve) => setTimeout(resolve, checkAfter * 1000));
  }

  return finalizeResult.media_id_string;
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
      const error = new Error("Missing access token for X");
      (error as any).code = "X_NO_ACCESS_TOKEN";
      throw error;
    }

    if (!consumerKey || !consumerSecret) {
      const error = new Error("Missing X consumer credentials");
      (error as any).code = "X_NO_CONSUMER_KEYS";
      throw error;
    }

    // X supports both images and videos
    const isVideo = mediaItem.mimeType?.startsWith("video/");
    const isImage = mediaItem.mimeType?.startsWith("image/");

    if (!isVideo && !isImage) {
      const error = new Error("X only supports image and video uploads");
      (error as any).code = "X_INVALID_MEDIA_TYPE";
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
      tweetText = tweetText.substring(0, 277) + "...";
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

    // Use X API v2 endpoint for tweet creation (Free tier compatible)
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

    const tweetResponse = await fetch(tweetUrl, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tweetPayload),
    });

    if (!tweetResponse.ok) {
      const errorBody = await tweetResponse.text().catch(() => "Unable to read error");
      console.error("[X OAuth 1.0a] Tweet creation failed", {
        status: tweetResponse.status,
        errorBody,
      });
      const error = new Error(`X tweet creation failed: ${errorBody}`);
      (error as any).code = "X_TWEET_FAILED";
      throw error;
    }

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
