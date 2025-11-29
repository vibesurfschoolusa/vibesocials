import type { PlatformClient, PublishContext, PublishResult } from "./types";

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

async function uploadImage(
  accessToken: string,
  ownerUrn: string,
  imageUrl: string
): Promise<string> {
  console.log("[LinkedIn] Starting image upload", { imageUrl });

  // Step 1: Register image upload
  const registerResponse = await fetch(
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
    const errorText = await registerResponse.text();
    console.error("[LinkedIn] Image registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn image registration failed: ${errorText}`);
  }

  const registerData: LinkedInAssetUploadResponse = await registerResponse.json();
  const uploadUrl =
    registerData.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const assetUrn = registerData.value.asset;

  console.log("[LinkedIn] Image registered", { assetUrn });

  // Step 2: Download image from blob storage
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image from ${imageUrl}`);
  }
  const imageBuffer = await imageResponse.arrayBuffer();

  // Step 3: Upload image to LinkedIn
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: imageBuffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    console.error("[LinkedIn] Image upload failed", {
      status: uploadResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn image upload failed: ${errorText}`);
  }

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

  // Step 1: Download video from blob storage
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to fetch video from ${videoUrl}`);
  }
  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  const videoSize = videoBuffer.length;

  console.log("[LinkedIn] Video downloaded", { sizeBytes: videoSize });

  // Step 2: Register video upload using Assets API (for UGC, not ads)
  console.log("[LinkedIn] Registering video with owner", { 
    ownerUrn,
    fileSizeBytes: videoSize,
  });
  
  const registerResponse = await fetch(
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
    const errorText = await registerResponse.text();
    console.error("[LinkedIn] Video registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn video registration failed: ${errorText}`);
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
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: videoBuffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    console.error("[LinkedIn] Video upload failed", {
      status: uploadResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn video upload failed: ${errorText}`);
  }

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

  const response = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(postBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[LinkedIn] Post creation failed", {
      status: response.status,
      error: errorText,
    });
    throw new Error(`LinkedIn post creation failed: ${errorText}`);
  }

  const responseData = await response.json();
  const postId = responseData.id;

  console.log("[LinkedIn] Post created successfully", { postId });
  return postId;
}

export const linkedinClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for LinkedIn");
      (error as any).code = "LINKEDIN_NO_ACCESS_TOKEN";
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
