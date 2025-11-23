import type { SocialConnection } from "@prisma/client";

import type { PlatformClient, PublishContext, PublishResult } from "./types";

async function refreshAccessToken(connection: SocialConnection): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    throw new Error("No refresh token available for YouTube");
  }

  const clientId = process.env.GOOGLE_GBP_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_GBP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing YouTube OAuth credentials");
  }

  console.log("[YouTube] Refreshing access token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unable to read error");
    console.error("[YouTube] Token refresh failed", {
      status: response.status,
      errorBody,
    });
    throw new Error("Failed to refresh YouTube access token");
  }

  const tokenData = (await response.json()) as {
    access_token: string;
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
      expiresAt,
    },
  });

  console.log("[YouTube] Access token refreshed successfully");

  return updated;
}

export const youtubeClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    // Check if token needs refresh
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[YouTube] Access token expired, refreshing...");
      socialConnection = await refreshAccessToken(socialConnection);
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for YouTube");
      (error as any).code = "YOUTUBE_NO_ACCESS_TOKEN";
      throw error;
    }

    // YouTube only supports videos
    if (mediaItem.mimeType && !mediaItem.mimeType.startsWith("video/")) {
      console.warn("[YouTube] Attempting to upload non-video media", {
        mimeType: mediaItem.mimeType,
        originalFilename: mediaItem.originalFilename,
      });
      const error = new Error("YouTube only supports video uploads");
      (error as any).code = "YOUTUBE_MEDIA_NOT_VIDEO";
      throw error;
    }

    console.log("[YouTube] Starting video upload", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
    });

    // Fetch the video from Vercel Blob
    const mediaUrl = mediaItem.storageLocation;
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      const error = new Error("Failed to fetch media from storage");
      (error as any).code = "YOUTUBE_FETCH_MEDIA_FAILED";
      throw error;
    }

    const videoBytes = Buffer.from(await mediaResponse.arrayBuffer());

    // Extract hashtags from caption for tags (YouTube supports up to 500 chars of tags)
    const hashtagMatches = caption.match(/#[\w]+/g) || [];
    const tags = hashtagMatches.map(tag => tag.substring(1)); // Remove # prefix

    // Get location from metadata if available
    const locationData = (mediaItem.metadata as any)?.location;

    // YouTube video metadata
    // Use baseCaption for title (no footer), full caption for description (with footer)
    const title = (mediaItem.baseCaption || caption).substring(0, 100); // YouTube title max 100 chars
    const metadata: any = {
      snippet: {
        title,
        description: caption, // Full caption with footer
        categoryId: "22", // People & Blogs (default category)
        tags: tags.length > 0 ? tags : undefined, // Add extracted hashtags as tags
      },
      status: {
        privacyStatus: "public", // Options: public, private, unlisted
        selfDeclaredMadeForKids: false, // Not made for kids
      },
    };

    // Add location/recording details if available
    if (locationData?.latitude && locationData?.longitude) {
      metadata.recordingDetails = {
        location: {
          latitude: locationData.latitude,
          longitude: locationData.longitude,
        },
      };
      if (locationData.description) {
        metadata.recordingDetails.locationDescription = locationData.description;
      }
    }

    console.log("[YouTube] Uploading with metadata", {
      title: metadata.snippet.title,
      descriptionLength: caption.length,
      tags: tags,
      hasLocation: !!locationData,
      privacyStatus: metadata.status.privacyStatus,
      madeForKids: false,
    });

    // Create multipart upload
    const boundary = "----VibeSocialsYouTubeBoundary";
    const metadataBody = JSON.stringify(metadata);

    const parts = [
      `--${boundary}\r\n`,
      `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
      `${metadataBody}\r\n`,
      `--${boundary}\r\n`,
      `Content-Type: ${mediaItem.mimeType || "video/mp4"}\r\n\r\n`,
    ];

    const partBuffers = parts.map((p) => Buffer.from(p, "utf-8"));
    const endBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");

    const body = Buffer.concat([...partBuffers, videoBytes, endBoundary]);

    // Upload to YouTube
    // Include recordingDetails in parts if location is provided
    const apiParts = locationData ? "snippet,status,recordingDetails" : "snippet,status";
    const uploadResponse = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=${apiParts}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": body.length.toString(),
        },
        body,
      },
    );

    if (!uploadResponse.ok) {
      const errorBody = await uploadResponse.text().catch(() => "Unable to read error body");
      console.error("[YouTube] Upload failed", {
        status: uploadResponse.status,
        statusText: uploadResponse.statusText,
        errorBody,
      });
      const error = new Error(`YouTube upload failed: ${errorBody}`);
      (error as any).code = "YOUTUBE_UPLOAD_FAILED";
      throw error;
    }

    const result = (await uploadResponse.json()) as {
      id?: string;
      snippet?: {
        title?: string;
      };
    };

    const videoId = result.id;
    if (!videoId) {
      console.error("[YouTube] No video ID in response", result);
      const error = new Error("YouTube did not return a video ID");
      (error as any).code = "YOUTUBE_NO_VIDEO_ID";
      throw error;
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log("[YouTube] Video uploaded successfully", {
      videoId,
      videoUrl,
      title: result.snippet?.title,
    });

    return {
      externalPostId: videoId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
