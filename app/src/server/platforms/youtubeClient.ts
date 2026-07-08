import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

import { refreshGoogleToken } from "./googleTokens";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

export const youtubeClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    // Check if token needs refresh
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date()) {
      console.log("[YouTube] Access token expired, refreshing...");
      socialConnection = await refreshGoogleToken(socialConnection);
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

    // Fetch the video from Vercel Blob.
    // fetchWithTimeout's own timeoutMs only bounds the connection + response
    // headers; pass AbortSignal.timeout as init.signal to also bound the
    // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
    const mediaUrl = mediaItem.storageLocation;
    const mediaResponse = await fetchWithTimeout(
      mediaUrl,
      { signal: AbortSignal.timeout(120_000) },
      120_000,
    );
    await assertOk(mediaResponse, {
      code: "YOUTUBE_FETCH_MEDIA_FAILED",
      prefix: "Failed to fetch media from storage",
    });

    const videoBytes = Buffer.from(await mediaResponse.arrayBuffer());

    // Extract hashtags from caption for tags (YouTube supports up to 500 chars of tags)
    const hashtagMatches = caption.match(/#[\w]+/g) || [];
    const tags = hashtagMatches.map(tag => tag.substring(1)); // Remove # prefix

    // Parse location from metadata if available
    // Supports formats: "lat,lng" or "description" or both
    const locationMetadata = (mediaItem.metadata as any)?.location;
    let locationData: { latitude?: number; longitude?: number; description?: string } | null = null;
    
    console.log("[YouTube] Raw metadata from mediaItem:", {
      metadata: mediaItem.metadata,
      locationMetadata,
    });
    
    if (locationMetadata?.description) {
      const locStr = locationMetadata.description.trim();
      
      console.log("[YouTube] Parsing location string:", locStr);
      
      // Try to extract coordinates from the string (format: "lat,lng" or "description (lat,lng)")
      const coordMatch = locStr.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
      
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        
        console.log("[YouTube] Found coordinates:", { lat, lng, valid: !isNaN(lat) && !isNaN(lng) });
        
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          locationData = {
            latitude: lat,
            longitude: lng,
          };
          
          // Extract description if it's not just coordinates
          const descOnly = locStr.replace(/\s*\(?\s*-?\d+\.?\d*,\s*-?\d+\.?\d*\s*\)?/, '').trim();
          if (descOnly && descOnly !== locStr) {
            locationData.description = descOnly;
          }
          
          console.log("[YouTube] Parsed location data:", locationData);
        }
      } else {
        // No coordinates found, store as description only for other platforms
        // YouTube won't get location without coordinates
        console.log("[YouTube] Location text provided but no coordinates, skipping location for YouTube:", locStr);
      }
    } else {
      console.log("[YouTube] No location metadata found");
    }

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
        privacyStatus: ctx.youtubeMetadata?.privacyStatus ?? "unlisted", // User-selected; defaults to unlisted, never auto-public
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
      location: locationData ? {
        lat: locationData.latitude,
        lng: locationData.longitude,
        description: locationData.description,
      } : null,
      privacyStatus: metadata.status.privacyStatus,
      madeForKids: false,
    });

    // Create multipart upload
    const boundary = "----VibeSocialsYouTubeBoundary";
    const metadataBody = JSON.stringify(metadata);
    
    console.log("[YouTube] Full metadata being sent to API:", metadataBody);

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
    const uploadResponse = await fetchWithTimeout(
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
      120_000,
    );

    await assertOk(uploadResponse, {
      code: "YOUTUBE_UPLOAD_FAILED",
      prefix: "YouTube upload failed",
    });

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

    const uploadData = result;

    console.log("[YouTube] Video uploaded successfully", {
      videoId: uploadData.id,
      videoUrl: `https://www.youtube.com/watch?v=${uploadData.id}`,
      title: uploadData.snippet?.title,
    });

    // Note: YouTube API does not support setting recordingDetails (location) via API
    // Location can only be set manually via YouTube Studio or mobile apps
    // We keep the location in our database for other platforms (Instagram, TikTok, X)
    if (locationData?.latitude && locationData?.longitude) {
      console.log("[YouTube] Location data available but cannot be set via API", {
        location: locationData,
        note: "YouTube requires manual location setting via Studio or mobile app",
      });
    }

    return {
      externalPostId: uploadData.id,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshGoogleToken(connection);
  },
};
