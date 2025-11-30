import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

async function refreshAccessToken(
  connection: SocialConnection,
): Promise<SocialConnection> {
  // For now, Facebook Page access tokens are treated as long-lived.
  // If we later add short-lived token handling, we'll implement a refresh flow here.
  console.log("[FacebookPage] Token refresh not implemented - using existing page access token");
  return connection;
}

export const facebookPageClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Facebook Page");
      (error as any).code = "FACEBOOK_PAGE_NO_ACCESS_TOKEN";
      throw error;
    }

    const pageId = socialConnection.accountIdentifier;
    if (!pageId) {
      const error = new Error("Missing Facebook Page ID");
      (error as any).code = "FACEBOOK_PAGE_NO_ID";
      throw error;
    }

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("image/")) {
      const error = new Error(
        "Facebook Page posting currently supports images only. Please upload an image.",
      );
      (error as any).code = "FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE";
      throw error;
    }

    console.log("[FacebookPage] Starting photo publish", {
      pageId,
      storageLocation: mediaItem.storageLocation,
      captionLength: caption?.length ?? 0,
    });

    const endpoint = new URL(`https://graph.facebook.com/v21.0/${pageId}/photos`);

    const body = new URLSearchParams({
      url: mediaItem.storageLocation,
      caption: caption ?? "",
      access_token: accessToken,
    });

    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unable to read error body");
      console.error("[FacebookPage] Photo publish failed", {
        status: response.status,
        statusText: response.statusText,
        errorBody,
      });
      const error = new Error(`Facebook Page photo publish failed: ${errorBody}`);
      (error as any).code = "FACEBOOK_PAGE_PUBLISH_FAILED";
      throw error;
    }

    const data = (await response.json()) as { id?: string };
    const externalPostId = data.id ?? null;

    console.log("[FacebookPage] Photo published successfully", {
      pageId,
      externalPostId,
    });

    return {
      externalPostId,
    };
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    return refreshAccessToken(connection);
  },
}
