import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";
import { prisma } from "@/lib/db";

async function refreshAccessToken(
  connection: SocialConnection,
): Promise<SocialConnection> {
  // Instagram uses Facebook long-lived tokens (60 days)
  // These don't have a refresh token, they just expire
  console.log("[Instagram] Token refresh not implemented - using long-lived token");
  return connection;
}

export const instagramClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Instagram");
      (error as any).code = "INSTAGRAM_NO_ACCESS_TOKEN";
      throw error;
    }

    const metadata = (socialConnection.metadata as any) || {};
    const igAccountId = socialConnection.accountIdentifier;

    if (!igAccountId) {
      const error = new Error("Missing Instagram account ID");
      (error as any).code = "INSTAGRAM_NO_ACCOUNT_ID";
      throw error;
    }

    console.log("[Instagram] Starting media upload", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
      igAccountId,
    });

    const mediaUrl = mediaItem.storageLocation;
    const isVideo = mediaItem.mimeType?.startsWith("video/");

    // Parse location from metadata if available
    const locationMetadata = (mediaItem.metadata as any)?.location;
    let locationId: string | undefined;

    if (locationMetadata?.description) {
      const locStr = locationMetadata.description.trim();
      const coordMatch = locStr.match(/\((-?\d+\.?\d*),\s*(-?\d+\.?\d*)\)/);

      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);

        console.log("[Instagram] Location coordinates found", { lat, lng });
        // Note: Instagram Graph API requires a Facebook Place ID, not just coordinates
        // For now, we'll skip location. To add it, you'd need to search Facebook Places API
        // with these coordinates to get a location_id
      }
    }

    try {
      // Step 1: Create media container
      const containerUrl = new URL(`https://graph.facebook.com/v21.0/${igAccountId}/media`);
      
      const containerParams: Record<string, string> = {
        access_token: accessToken,
        caption: caption,
      };

      if (isVideo) {
        // Instagram now requires REELS for video posts (VIDEO is deprecated)
        containerParams.media_type = "REELS";
        containerParams.video_url = mediaUrl;
      } else {
        containerParams.image_url = mediaUrl;
      }

      if (locationId) {
        containerParams.location_id = locationId;
      }

      Object.entries(containerParams).forEach(([key, value]) => {
        containerUrl.searchParams.set(key, value);
      });

      console.log("[Instagram] Creating media container", {
        mediaType: isVideo ? "REELS" : "IMAGE",
        hasLocation: !!locationId,
      });

      const containerResponse = await fetch(containerUrl.toString(), {
        method: "POST",
      });

      if (!containerResponse.ok) {
        const errorBody = await containerResponse.text();
        console.error("[Instagram] Container creation failed", {
          status: containerResponse.status,
          error: errorBody,
        });
        const error = new Error(`Instagram container creation failed: ${errorBody}`);
        (error as any).code = "INSTAGRAM_CONTAINER_FAILED";
        throw error;
      }

      const containerData = (await containerResponse.json()) as {
        id: string;
      };

      const containerId = containerData.id;

      console.log("[Instagram] Container created", { containerId });

      // Step 2: Wait for media processing
      if (isVideo) {
        console.log("[Instagram] Waiting for video processing...");
        
        let isReady = false;
        let attempts = 0;
        const maxAttempts = 30; // 30 attempts * 5 seconds = 2.5 minutes max

        while (!isReady && attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

          const statusUrl = new URL(`https://graph.facebook.com/v21.0/${containerId}`);
          statusUrl.searchParams.set("fields", "status_code");
          statusUrl.searchParams.set("access_token", accessToken);

          const statusResponse = await fetch(statusUrl.toString());
          if (statusResponse.ok) {
            const statusData = (await statusResponse.json()) as {
              status_code?: string;
            };

            console.log("[Instagram] Video status:", statusData.status_code);

            if (statusData.status_code === "FINISHED") {
              isReady = true;
            } else if (statusData.status_code === "ERROR") {
              const error = new Error("Instagram video processing failed");
              (error as any).code = "INSTAGRAM_VIDEO_PROCESSING_ERROR";
              throw error;
            }
          }

          attempts++;
        }

        if (!isReady) {
          const error = new Error("Instagram video processing timeout");
          (error as any).code = "INSTAGRAM_VIDEO_TIMEOUT";
          throw error;
        }

        console.log("[Instagram] Video processing complete");
      } else {
        // For images, wait a brief moment for Instagram to process
        console.log("[Instagram] Waiting for image processing...");
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
      }

      // Step 3: Publish the container
      const publishUrl = new URL(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`);
      publishUrl.searchParams.set("creation_id", containerId);
      publishUrl.searchParams.set("access_token", accessToken);

      console.log("[Instagram] Publishing media container");

      const publishResponse = await fetch(publishUrl.toString(), {
        method: "POST",
      });

      if (!publishResponse.ok) {
        const errorBody = await publishResponse.text();
        console.error("[Instagram] Publish failed", {
          status: publishResponse.status,
          error: errorBody,
        });
        const error = new Error(`Instagram publish failed: ${errorBody}`);
        (error as any).code = "INSTAGRAM_PUBLISH_FAILED";
        throw error;
      }

      const publishData = (await publishResponse.json()) as {
        id: string;
      };

      const mediaId = publishData.id;

      console.log("[Instagram] Media published successfully", {
        mediaId,
        username: metadata.username,
      });

      return {
        externalPostId: mediaId,
      };
    } catch (error: any) {
      console.error("[Instagram] Publish error", error);
      throw error;
    }
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
};
