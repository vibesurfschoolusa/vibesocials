import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

// COR-5: Instagram token expiry handling.
//
// Token-material reality (see app/src/app/api/auth/instagram/callback/route.ts):
// the connection's `accessToken` is a long-lived Facebook PAGE access token
// (minted from a long-lived user token during OAuth) and `refreshToken` is
// stored as null. Page tokens derived from a long-lived user token carry no
// refresh token and generally do not expire on a fixed clock, but they CAN be
// invalidated (the user revokes access / changes password, or the parent
// long-lived user token lapses). The stored `expiresAt` mirrors that user
// token's ~60-day window and is used here as a conservative "time to prompt
// reconnect" signal.
//
// There is deliberately NO refresh call: `fb_exchange_token` re-extends USER
// tokens, not page tokens, and no user token is stored — so the only real
// recovery is to reconnect. The fix is therefore an expiry check on the token
// actually used for publishing, surfaced as a clean, coded reconnect error.

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // treat tokens within 5 min of expiry as expired

function isExpiredOrExpiringSoon(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded -> cannot judge; let publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

function instagramReconnectRequiredError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    "Your Instagram connection has expired — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = "INSTAGRAM_RECONNECT_REQUIRED";
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Guard the token before hitting the Graph API. Instagram cannot refresh (see
 * file header), so an expired/near-expired token becomes a clean, actionable
 * reconnect error instead of a raw OAuth failure surfaced to the user via
 * PostJobResult.errorMessage. Returns the connection unchanged when usable.
 * Exported for unit tests.
 */
export function ensureFreshInstagramToken(
  connection: SocialConnection,
): SocialConnection {
  if (isExpiredOrExpiringSoon(connection.expiresAt)) {
    throw instagramReconnectRequiredError();
  }
  return connection;
}

export const instagramClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    // COR-5: fail fast with a clear reconnect error if the page token has
    // aged out, rather than letting the Graph API return a cryptic OAuth error.
    socialConnection = ensureFreshInstagramToken(socialConnection);

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
        // COR-5: a 401 here means the page token is no longer accepted — map it
        // to the actionable reconnect error instead of leaking the raw body.
        if (containerResponse.status === 401) {
          throw instagramReconnectRequiredError();
        }
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
        // COR-5: 401 on publish -> token no longer valid; ask for reconnect.
        if (publishResponse.status === 401) {
          throw instagramReconnectRequiredError();
        }
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
    // Instagram page tokens cannot be refreshed (see file header). Delegate to
    // the same guard used at publish time so any future caller gets correct
    // behavior — a fresh connection or a coded reconnect error — not a silent
    // no-op that hides an expired token.
    return ensureFreshInstagramToken(connection);
  },
};
