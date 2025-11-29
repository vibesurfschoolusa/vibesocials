import type { PlatformClient, PublishContext, PublishResult } from "./types";

/**
 * LinkedIn API client for posting images and videos
 * Uses LinkedIn UGC Post API (v2)
 * 
 * Documentation:
 * - UGC Posts: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api
 * - Images: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/images-api
 * - Videos: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/videos-api
 */

interface LinkedInImageUploadResponse {
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

interface LinkedInVideoUploadResponse {
  value: {
    uploadInstructions: Array<{
      uploadUrl: string;
      lastByte: number;
      firstByte: number;
    }>;
    video: string;
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

  const registerData: LinkedInImageUploadResponse = await registerResponse.json();
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

  // Step 2: Initialize video upload
  console.log("[LinkedIn] Initializing video with owner", { 
    ownerUrn,
    fileSizeBytes: videoSize,
  });
  
  const initResponse = await fetch(
    "https://api.linkedin.com/v2/videos?action=initializeUpload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: ownerUrn,
          fileSizeBytes: videoSize,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    }
  );

  if (!initResponse.ok) {
    const errorText = await initResponse.text();
    console.error("[LinkedIn] Video initialization failed", {
      status: initResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn video initialization failed: ${errorText}`);
  }

  const initData: LinkedInVideoUploadResponse = await initResponse.json();
  console.log("[LinkedIn] Full video init response:", JSON.stringify(initData, null, 2));
  
  const videoUrn = initData.value.video;
  const uploadInstructions = initData.value.uploadInstructions;

  console.log("[LinkedIn] Video initialized", {
    videoUrn,
    chunks: uploadInstructions.length,
  });

  // Step 3: Upload video in chunks and collect ETags
  const uploadedPartIds: string[] = [];
  
  for (const instruction of uploadInstructions) {
    const chunk = videoBuffer.slice(instruction.firstByte, instruction.lastByte + 1);

    const chunkResponse = await fetch(instruction.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    });

    if (!chunkResponse.ok) {
      const errorText = await chunkResponse.text();
      console.error("[LinkedIn] Video chunk upload failed", {
        status: chunkResponse.status,
        error: errorText,
        firstByte: instruction.firstByte,
        lastByte: instruction.lastByte,
      });
      throw new Error(`LinkedIn video chunk upload failed: ${errorText}`);
    }

    // Capture ETag from response headers (required for finalization)
    const etag = chunkResponse.headers.get("ETag");
    if (etag) {
      // Remove quotes from ETag if present
      uploadedPartIds.push(etag.replace(/"/g, ""));
    }

    console.log("[LinkedIn] Chunk uploaded", {
      firstByte: instruction.firstByte,
      lastByte: instruction.lastByte,
      etag,
    });
  }

  console.log("[LinkedIn] All chunks uploaded", {
    totalChunks: uploadInstructions.length,
    etagsCollected: uploadedPartIds.length,
  });

  // Step 4: Finalize video upload with ETags
  const finalizeResponse = await fetch(
    `https://api.linkedin.com/v2/videos?action=finalizeUpload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: "",
          uploadedPartIds,
        },
      }),
    }
  );

  if (!finalizeResponse.ok) {
    const errorText = await finalizeResponse.text();
    console.error("[LinkedIn] Video finalization failed", {
      status: finalizeResponse.status,
      error: errorText,
    });
    throw new Error(`LinkedIn video finalization failed: ${errorText}`);
  }

  const finalizeData = await finalizeResponse.json();
  console.log("[LinkedIn] Full finalization response:", JSON.stringify(finalizeData, null, 2));
  console.log("[LinkedIn] Video upload completed", { videoUrn });
  
  // Poll video status to ensure it's ready and ownership is processed
  await waitForVideoReady(accessToken, videoUrn, ownerUrn);
  
  return videoUrn;
}

async function waitForVideoReady(
  accessToken: string,
  videoUrn: string,
  expectedOwner: string,
  maxAttempts: number = 10,
  delayMs: number = 2000
): Promise<void> {
  console.log("[LinkedIn] Waiting for video to be ready", { videoUrn, expectedOwner });
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Check video status
      const statusResponse = await fetch(
        `https://api.linkedin.com/v2/videos/${encodeURIComponent(videoUrn)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Restli-Protocol-Version": "2.0.0",
          },
        }
      );
      
      if (statusResponse.ok) {
        const videoData = await statusResponse.json();
        const status = videoData.status;
        const owner = videoData.owner;
        
        // Log full video data on first successful check
        if (attempt === 1 || status === "AVAILABLE") {
          console.log(`[LinkedIn] Full video status response (attempt ${attempt}):`, JSON.stringify(videoData, null, 2));
        }
        
        console.log(`[LinkedIn] Video status check (attempt ${attempt}/${maxAttempts})`, {
          status,
          owner,
          expectedOwner,
          ownerMatch: owner === expectedOwner,
        });
        
        // Check if video is ready and owned by the correct entity
        if (status === "AVAILABLE" && owner === expectedOwner) {
          console.log("[LinkedIn] Video is ready and ownership confirmed!");
          return;
        }
        
        // If status is failed or processing is stuck, throw error
        if (status === "FAILED" || status === "PROCESSING_FAILED") {
          throw new Error(`LinkedIn video processing failed with status: ${status}`);
        }
      } else {
        console.log(`[LinkedIn] Video status check failed (attempt ${attempt}/${maxAttempts})`, {
          status: statusResponse.status,
        });
      }
      
      // Wait before next attempt (unless it's the last one)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      console.log(`[LinkedIn] Error checking video status (attempt ${attempt}/${maxAttempts})`, error);
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  // If we've exhausted attempts, log warning but continue (fallback to delay-based approach)
  console.warn("[LinkedIn] Could not confirm video ready status, proceeding anyway after max attempts");
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
        // uploadVideo now includes status polling to wait for ownership
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
