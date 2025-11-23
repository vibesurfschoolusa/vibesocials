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

    const uploadData = result;

    console.log("[YouTube] Video uploaded successfully", {
      videoId: uploadData.id,
      videoUrl: `https://www.youtube.com/watch?v=${uploadData.id}`,
      title: uploadData.snippet?.title,
    });

    // If we have location data, update the video with recordingDetails
    // YouTube doesn't always accept recordingDetails during initial upload
    if (locationData?.latitude && locationData?.longitude) {
      console.log("[YouTube] Updating video with location data...");
      
      try {
        const updateResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=recordingDetails`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id: uploadData.id,
              recordingDetails: {
                location: {
                  latitude: locationData.latitude,
                  longitude: locationData.longitude,
                },
                locationDescription: locationData.description || undefined,
              },
            }),
          },
        );

        if (updateResponse.ok) {
          const updateData = await updateResponse.json();
          console.log("[YouTube] Location updated successfully", {
            recordingDetails: updateData.recordingDetails,
          });
        } else {
          const errorText = await updateResponse.text();
          console.error("[YouTube] Failed to update location", {
            status: updateResponse.status,
            error: errorText,
          });
        }
      } catch (error) {
        console.error("[YouTube] Error updating location", error);
        // Don't fail the whole upload if location update fails
      }
    }

    return {
      externalPostId: uploadData.id,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
