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
  const mediaBase64 = mediaBuffer.toString("base64");

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
  
  const requestData = {
    url: uploadUrl,
    method: "POST",
    data: {
      media_data: mediaBase64,
    },
  };

  // Generate OAuth authorization header (includes body params in signature)
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

    // Create tweet with media using API v1.1 (OAuth 1.0a uses v1.1 endpoints)
    console.log("[X OAuth 1.0a] Creating tweet", {
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

    const tweetUrl = "https://api.twitter.com/1.1/statuses/update.json";
    const requestData = {
      url: tweetUrl,
      method: "POST",
      data: {
        status: tweetText,
        media_ids: mediaId,
      },
    };

    // Generate OAuth authorization header
    const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

    const tweetResponse = await fetch(tweetUrl, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        status: tweetText,
        media_ids: mediaId,
      }),
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
      id_str: string;
      text: string;
    };

    console.log("[X OAuth 1.0a] Tweet created successfully", {
      tweetId: tweetResult.id_str,
      tweetUrl: `https://twitter.com/i/web/status/${tweetResult.id_str}`,
    });

    return {
      externalPostId: tweetResult.id_str,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
