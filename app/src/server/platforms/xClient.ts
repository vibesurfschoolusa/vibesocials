import type { SocialConnection } from "@prisma/client";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

/**
 * Refresh X (Twitter) access token using refresh token
 */
async function refreshAccessToken(connection: SocialConnection): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    throw new Error("No refresh token available for X");
  }

  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing X OAuth credentials");
  }

  console.log("[X] Refreshing access token");

  // X uses Basic Auth for token endpoint
  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${authHeader}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unable to read error");
    console.error("[X] Token refresh failed", {
      status: response.status,
      errorBody,
    });
    throw new Error("Failed to refresh X access token");
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  // Update connection in database
  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
    },
  });

  console.log("[X] Access token refreshed successfully");

  return updated;
}

/**
 * Upload media to X (Twitter) using Media Upload API v1.1
 * Returns media_id_string for use in tweet creation
 */
async function uploadMedia(
  accessToken: string,
  mediaUrl: string,
  mimeType: string
): Promise<string> {
  console.log("[X] Starting media upload", { mediaUrl, mimeType });

  // Download media from Vercel Blob
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error("Failed to fetch media from storage");
  }

  const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
  const mediaBase64 = mediaBuffer.toString("base64");

  console.log("[X] Media downloaded", {
    sizeBytes: mediaBuffer.length,
    sizeMB: (mediaBuffer.length / 1024 / 1024).toFixed(2),
  });

  // Upload media using Media Upload API (v1.1 endpoint)
  // X supports INIT -> APPEND -> FINALIZE for large files, but for simplicity
  // we'll use simple upload for files < 5MB
  const uploadResponse = await fetch(
    "https://upload.twitter.com/1.1/media/upload.json",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        media_data: mediaBase64,
      }),
    }
  );

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text().catch(() => "Unable to read error");
    console.error("[X] Media upload failed", {
      status: uploadResponse.status,
      errorBody,
    });
    throw new Error(`X media upload failed: ${errorBody}`);
  }

  const uploadResult = (await uploadResponse.json()) as {
    media_id_string: string;
  };

  console.log("[X] Media uploaded successfully", {
    mediaId: uploadResult.media_id_string,
  });

  return uploadResult.media_id_string;
}

export const xClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    // Check if token needs refresh
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[X] Access token expired, refreshing...");
      socialConnection = await refreshAccessToken(socialConnection);
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for X");
      (error as any).code = "X_NO_ACCESS_TOKEN";
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

    console.log("[X] Starting post creation", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
      isVideo,
      isImage,
    });

    // Upload media first
    const mediaUrl = mediaItem.storageLocation;
    const mediaId = await uploadMedia(accessToken, mediaUrl, mediaItem.mimeType || "");

    // X tweet character limit is 280
    // If caption is longer, we'll truncate with ellipsis
    let tweetText = caption;
    if (tweetText.length > 280) {
      tweetText = tweetText.substring(0, 277) + "...";
      console.log("[X] Caption truncated to 280 characters");
    }

    // Create tweet with media using API v2
    const tweetPayload = {
      text: tweetText,
      media: {
        media_ids: [mediaId],
      },
    };

    console.log("[X] Creating tweet", {
      textLength: tweetText.length,
      mediaId,
    });

    const tweetResponse = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tweetPayload),
    });

    if (!tweetResponse.ok) {
      const errorBody = await tweetResponse.text().catch(() => "Unable to read error");
      console.error("[X] Tweet creation failed", {
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

    console.log("[X] Tweet created successfully", {
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
