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
  personUrn: string,
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
          owner: personUrn,
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
  personUrn: string,
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
          owner: personUrn,
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
  const videoUrn = initData.value.video;
  const uploadInstructions = initData.value.uploadInstructions;

  console.log("[LinkedIn] Video initialized", {
    videoUrn,
    chunks: uploadInstructions.length,
  });

  // Step 3: Upload video in chunks
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

    console.log("[LinkedIn] Chunk uploaded", {
      firstByte: instruction.firstByte,
      lastByte: instruction.lastByte,
    });
  }

  // Step 4: Finalize video upload
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
          uploadedPartIds: [],
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

  console.log("[LinkedIn] Video upload completed", { videoUrn });
  return videoUrn;
}

async function createPost(
  accessToken: string,
  personUrn: string,
  caption: string,
  mediaUrn?: string,
  isVideo: boolean = false
): Promise<string> {
  console.log("[LinkedIn] Creating post", {
    personUrn,
    hasMedia: !!mediaUrn,
    isVideo,
  });

  const postBody: any = {
    author: personUrn,
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
    postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [
      {
        status: "READY",
        [isVideo ? "media" : "media"]: mediaUrn,
      },
    ];
  }

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

    const personUrn = `urn:li:person:${socialConnection.accountIdentifier}`;
    const mediaUrl = mediaItem.storageLocation;
    const isVideo = mediaItem.mimeType.startsWith("video/");

    console.log("[LinkedIn] Starting media upload", {
      mediaUrl,
      mimeType: mediaItem.mimeType,
      isVideo,
      filename: mediaItem.originalFilename,
    });

    try {
      let mediaUrn: string | undefined;

      // Upload media if present
      if (isVideo) {
        mediaUrn = await uploadVideo(
          accessToken,
          personUrn,
          mediaUrl,
          mediaItem.originalFilename
        );
      } else if (mediaItem.mimeType.startsWith("image/")) {
        mediaUrn = await uploadImage(accessToken, personUrn, mediaUrl);
      }

      // Create the post
      const postId = await createPost(
        accessToken,
        personUrn,
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
