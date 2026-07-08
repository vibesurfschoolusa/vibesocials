import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

/**
 * LinkedIn API client for posting images and videos
 * Uses LinkedIn UGC Post API (v2) and Assets API for media upload
 * 
 * Documentation:
 * - UGC Posts: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api
 * - Assets API: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/images-api
 * 
 * Note: Both images and videos use the Assets API with UGC service relationships
 * to ensure they can be used in organic posts (not just advertising).
 */

interface LinkedInAssetUploadResponse {
  value: {
    uploadMechanism: {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
        uploadUrl: string;
        headers: Record<string, string>;
      };
    };
    asset: string;
    mediaArtifact: string;
  };
}

// COR-5: LinkedIn token expiry handling.
//
// Token-material reality (see app/src/app/api/auth/linkedin/callback/route.ts):
// the connection stores a ~60-day `accessToken` and a `refreshToken` ONLY when
// LinkedIn actually returns one. Programmatic refresh tokens are issued solely
// to approved LinkedIn partner programs; standard / dev-tier apps (this app)
// receive a 60-day access token with NO refresh_token. So the correct behavior
// for the common case is a clean, coded "reconnect" failure — NOT a fabricated
// refresh. When a refresh_token IS present (partner apps) we run the standard
// refresh_token grant under the same persist discipline as googleTokens.ts:
// write ONLY accessToken + expiresAt, never refreshToken or metadata wholesale.
//
// Caveat: LinkedIn may rotate the refresh_token on refresh. Per the program-wide
// discipline (never overwrite a stored refreshToken in an update) we do not
// persist a rotated token; if rotation invalidates the stored one, the next
// cycle surfaces LINKEDIN_RECONNECT_REQUIRED — the correct user action.

const LINKEDIN_TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_DEFAULT_TOKEN_TTL_SECONDS = 5_184_000; // LinkedIn access tokens last ~60 days
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // treat tokens within 5 min of expiry as expired

function isExpiredOrExpiringSoon(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded -> cannot judge; let publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

function linkedinReconnectRequiredError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    "Your LinkedIn connection has expired — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = "LINKEDIN_RECONNECT_REQUIRED";
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Refresh a LinkedIn access token using a stored refresh_token (partner apps
 * only). Persists ONLY accessToken + expiresAt — never refreshToken or metadata
 * — mirroring the discipline pinned by googleTokens.ts. Exported for unit tests.
 *
 * Throws (with `error.code`):
 * - `LINKEDIN_NO_REFRESH_TOKEN` if the connection has no stored refresh token.
 * - `LINKEDIN_MISSING_OAUTH_CREDENTIALS` if the OAuth client env vars are absent.
 * - `LINKEDIN_TOKEN_REFRESH_FAILED` (sanitized, via assertOk) on a non-2xx; the
 *   upstream body is logged server-side but never surfaced to the user.
 */
export async function refreshLinkedInToken(
  connection: SocialConnection,
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    const error = new Error(
      "No refresh token available for this LinkedIn connection",
    ) as Error & { code: string };
    error.code = "LINKEDIN_NO_REFRESH_TOKEN";
    throw error;
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error(
      "Missing LinkedIn OAuth credentials",
    ) as Error & { code: string };
    error.code = "LINKEDIN_MISSING_OAUTH_CREDENTIALS";
    throw error;
  }

  console.log("[LinkedIn] Refreshing access token", { connectionId: connection.id });

  const response = await fetchWithTimeout(LINKEDIN_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  await assertOk(response, {
    code: "LINKEDIN_TOKEN_REFRESH_FAILED",
    prefix: "Failed to refresh LinkedIn access token",
  });

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  // Guard: fall back to LinkedIn's standard ~60-day TTL if expires_in is
  // missing/non-finite, rather than persisting an Invalid Date.
  const expiresInSeconds =
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? tokenData.expires_in
      : LINKEDIN_DEFAULT_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  // Update ONLY accessToken + expiresAt. Never refreshToken or metadata. (See header.)
  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: tokenData.access_token,
      expiresAt,
    },
  });

  console.log("[LinkedIn] Access token refreshed successfully", {
    connectionId: connection.id,
  });

  return updated;
}

/**
 * Ensure the connection's access token is usable before publishing. If it is
 * expired/near-expiry: refresh it when a refresh_token is stored (partner apps),
 * otherwise throw LINKEDIN_RECONNECT_REQUIRED. Any refresh failure is likewise
 * surfaced as LINKEDIN_RECONNECT_REQUIRED (the actionable outcome), preserving
 * the original error as `cause` for server logs. Returns the (possibly
 * refreshed) connection. Exported for unit tests.
 */
export async function ensureFreshLinkedInToken(
  connection: SocialConnection,
): Promise<SocialConnection> {
  if (!isExpiredOrExpiringSoon(connection.expiresAt)) {
    return connection;
  }

  if (connection.refreshToken) {
    try {
      return await refreshLinkedInToken(connection);
    } catch (error) {
      throw linkedinReconnectRequiredError(error);
    }
  }

  throw linkedinReconnectRequiredError();
}

async function uploadImage(
  accessToken: string,
  ownerUrn: string,
  imageUrl: string
): Promise<string> {
  console.log("[LinkedIn] Starting image upload", { imageUrl });

  // Step 1: Register image upload
  const registerResponse = await fetchWithTimeout(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: ownerUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
        },
      }),
    }
  );

  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Image registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (registerResponse.status === 401) {
      throw linkedinReconnectRequiredError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn image registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_IMAGE_REGISTRATION_FAILED";
    throw error;
  }

  const registerData: LinkedInAssetUploadResponse = await registerResponse.json();
  const uploadUrl =
    registerData.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const assetUrn = registerData.value.asset;

  console.log("[LinkedIn] Image registered", { assetUrn });

  // Step 2: Download image from blob storage.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
  const imageResponse = await fetchWithTimeout(
    imageUrl,
    { signal: AbortSignal.timeout(120_000) },
    120_000,
  );
  await assertOk(imageResponse, {
    code: "LINKEDIN_IMAGE_DOWNLOAD_FAILED",
    prefix: "Failed to download image from storage",
  });
  const imageBuffer = await imageResponse.arrayBuffer();

  // Step 3: Upload image to LinkedIn
  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: imageBuffer,
    },
    120_000,
  );

  await assertOk(uploadResponse, {
    code: "LINKEDIN_IMAGE_UPLOAD_FAILED",
    prefix: "LinkedIn image upload failed",
  });

  console.log("[LinkedIn] Image uploaded successfully", { assetUrn });
  return assetUrn;
}

async function uploadVideo(
  accessToken: string,
  ownerUrn: string,
  videoUrl: string,
  filename: string
): Promise<string> {
  console.log("[LinkedIn] Starting video upload", { videoUrl, filename });

  // Step 1: Download video from blob storage.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
  const videoResponse = await fetchWithTimeout(
    videoUrl,
    { signal: AbortSignal.timeout(120_000) },
    120_000,
  );
  await assertOk(videoResponse, {
    code: "LINKEDIN_VIDEO_DOWNLOAD_FAILED",
    prefix: "Failed to download video from storage",
  });
  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  const videoSize = videoBuffer.length;

  console.log("[LinkedIn] Video downloaded", { sizeBytes: videoSize });

  // Step 2: Register video upload using Assets API (for UGC, not ads)
  console.log("[LinkedIn] Registering video with owner", { 
    ownerUrn,
    fileSizeBytes: videoSize,
  });
  
  const registerResponse = await fetchWithTimeout(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
          owner: ownerUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
        },
      }),
    }
  );

  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Video registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (registerResponse.status === 401) {
      throw linkedinReconnectRequiredError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn video registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_VIDEO_REGISTRATION_FAILED";
    throw error;
  }

  const registerData = await registerResponse.json();
  console.log("[LinkedIn] Full video registration response:", JSON.stringify(registerData, null, 2));
  
  const uploadUrl = registerData.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
  const assetUrn = registerData.value?.asset;
  
  if (!uploadUrl || !assetUrn) {
    throw new Error("LinkedIn video registration did not return upload URL or asset URN");
  }

  console.log("[LinkedIn] Video registered", { assetUrn });

  // Step 3: Upload video to LinkedIn
  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: videoBuffer,
    },
    120_000,
  );

  await assertOk(uploadResponse, {
    code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
    prefix: "LinkedIn video upload failed",
  });

  console.log("[LinkedIn] Video uploaded successfully", { assetUrn });
  return assetUrn;
}

async function createPost(
  accessToken: string,
  authorUrn: string,
  caption: string,
  mediaUrn?: string,
  isVideo: boolean = false
): Promise<string> {
  console.log("[LinkedIn] Creating post", {
    authorUrn,
    hasMedia: !!mediaUrn,
    isVideo,
  });

  const postBody: any = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: caption,
        },
        shareMediaCategory: mediaUrn
          ? isVideo
            ? "VIDEO"
            : "IMAGE"
          : "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  // Add media if provided
  if (mediaUrn) {
    if (isVideo) {
      // Videos require a different structure with title
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [
        {
          status: "READY",
          description: {
            text: caption || "Video"
          },
          media: mediaUrn,
          title: {
            text: "Video"
          }
        },
      ];
    } else {
      // Images use simpler structure
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [
        {
          status: "READY",
          description: {
            text: caption || "Image"
          },
          media: mediaUrn,
        },
      ];
    }
    
    console.log("[LinkedIn] Post body includes media", {
      mediaUrn,
      mediaType: isVideo ? "VIDEO" : "IMAGE",
      author: authorUrn,
      hasTitle: isVideo,
      hasDescription: true,
    });
  }

  console.log("[LinkedIn] Sending post to API", {
    endpoint: "https://api.linkedin.com/v2/ugcPosts",
    author: postBody.author,
    mediaCategory: postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory,
    hasMedia: !!mediaUrn,
  });
  
  // Log full post body for debugging
  console.log("[LinkedIn] Full post body:", JSON.stringify(postBody, null, 2));

  const response = await fetchWithTimeout("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(postBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Post creation failed", {
      status: response.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (response.status === 401) {
      throw linkedinReconnectRequiredError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn post creation failed (status ${response.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_POST_CREATION_FAILED";
    throw error;
  }

  const responseData = await response.json();
  const postId = responseData.id;

  console.log("[LinkedIn] Post created successfully", { postId });
  return postId;
}

export const linkedinClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption } = ctx;

    // COR-5: refresh the token when a refresh_token is stored (partner apps),
    // otherwise fail with a clear reconnect error — before we use the token.
    socialConnection = await ensureFreshLinkedInToken(socialConnection);

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for LinkedIn") as Error & {
        code: string;
      };
      error.code = "LINKEDIN_NO_ACCESS_TOKEN";
      throw error;
    }

    // Check if user has organizations/company pages
    const metadata = (socialConnection.metadata as any) || {};
    const organizations = metadata.organizations || [];
    
    // REQUIRE organization - never post to personal profile
    if (organizations.length === 0) {
      const error = new Error(
        "No LinkedIn company pages configured. This app only posts to company pages, not personal profiles.\n\n" +
        "To fix this:\n" +
        "1. Ensure you are an ADMINISTRATOR of a LinkedIn Company Page\n" +
        "2. Go to Settings → Connections\n" +
        "3. Disconnect and reconnect your LinkedIn account\n" +
        "4. The app will automatically detect your company pages\n\n" +
        "If this still fails, contact support with error code: LINKEDIN_NO_ORGANIZATION"
      );
      (error as any).code = "LINKEDIN_NO_ORGANIZATION";
      throw error;
    }
    
    // Use first organization
    const orgId = organizations[0].id;
    const authorUrn = `urn:li:organization:${orgId}`;
    console.log("[LinkedIn] Posting as organization", {
      orgId,
      orgName: organizations[0].name,
    });

    const mediaUrl = mediaItem.storageLocation;
    const isVideo = mediaItem.mimeType.startsWith("video/");

    console.log("[LinkedIn] Starting media upload", {
      mediaUrl,
      mimeType: mediaItem.mimeType,
      isVideo,
      filename: mediaItem.originalFilename,
      authorUrn,
    });

    try {
      let mediaUrn: string | undefined;

      // Upload media if present
      if (isVideo) {
        // uploadVideo now uses Assets API with UGC service relationship (like images)
        mediaUrn = await uploadVideo(
          accessToken,
          authorUrn,
          mediaUrl,
          mediaItem.originalFilename
        );
      } else if (mediaItem.mimeType.startsWith("image/")) {
        mediaUrn = await uploadImage(accessToken, authorUrn, mediaUrl);
      }

      // Create the post
      console.log("[LinkedIn] Creating post with URNs", {
        authorUrn,
        mediaUrn,
        match: mediaUrn ? `Video owner and post author both use: ${authorUrn}` : "No media",
      });
      
      const postId = await createPost(
        accessToken,
        authorUrn,
        caption,
        mediaUrn,
        isVideo
      );

      console.log("[LinkedIn] Publish successful", { postId });

      return {
        externalPostId: postId,
      };
    } catch (error) {
      console.error("[LinkedIn] Publish error", { error });
      throw error;
    }
  },
};
