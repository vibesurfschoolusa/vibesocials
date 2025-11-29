import type { PlatformClient, PublishContext, PublishResult } from "./types";

const TIKTOK_API_BASE = "https://open.tiktokapis.com";

export const tiktokClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for TikTok");
      (error as any).code = "TIKTOK_NO_ACCESS_TOKEN";
      throw error;
    }

    console.log('[TikTok] Media item details:', {
      mimeType: mediaItem.mimeType,
      originalFilename: mediaItem.originalFilename,
      storageLocation: mediaItem.storageLocation,
    });

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("video/")) {
      const error = new Error(`TikTok requires video files. Current mime type: ${mediaItem.mimeType || 'undefined'}`);
      (error as any).code = "TIKTOK_MEDIA_NOT_VIDEO";
      throw error;
    }

    // Download video from Vercel Blob Storage
    const videoUrl = mediaItem.storageLocation;
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      const error = new Error("Failed to fetch video from storage");
      (error as any).code = "TIKTOK_FETCH_VIDEO_FAILED";
      throw error;
    }
    
    const fileBytes = Buffer.from(await videoResponse.arrayBuffer());
    const size = fileBytes.byteLength;

    // TikTok title has a 2200 character limit, but captions are typically shorter
    // Truncate if needed to avoid API rejection
    const tiktokCaption = caption 
      ? (caption.length > 2200 ? caption.substring(0, 2200) : caption)
      : "Video posted via Vibe Socials";

    // Chunk the video to avoid timeout (TikTok recommends ~10MB chunks)
    const CHUNK_SIZE = 3 * 1024 * 1024; // 3MB chunks to stay well under 60s timeout
    const totalChunks = Math.ceil(size / CHUNK_SIZE);

    console.log('[TikTok] Initializing upload with FILE_UPLOAD (chunked)', {
      videoSize: size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      hasAccessToken: !!accessToken,
      captionPreview: tiktokCaption.substring(0, 100) + (tiktokCaption.length > 100 ? '...' : ''),
    });

    const postInfo = {
      title: tiktokCaption,
      privacy_level: "SELF_ONLY", // Sandbox mode restriction
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    };

    // Use Direct Post API with FILE_UPLOAD and captions
    const initRes = await fetch(
      `${TIKTOK_API_BASE}/v2/post/publish/video/init/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          post_info: postInfo,
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: CHUNK_SIZE,
            total_chunk_count: totalChunks,
          },
        }),
      },
    );

    if (!initRes.ok) {
      const errorBody = await initRes.text().catch(() => "Unable to read error body");
      console.error("[TikTok] video init failed", {
        status: initRes.status,
        statusText: initRes.statusText,
        errorBody,
      });
      const error = new Error(`Failed to start TikTok video upload: ${errorBody}`);
      (error as any).code = "TIKTOK_INIT_FAILED";
      throw error;
    }

    const initJson = (await initRes.json().catch(() => null)) as any;
    const initErrorCode = initJson?.error?.code;
    if (initErrorCode && initErrorCode !== "ok") {
      console.error("[TikTok] video init error payload", initJson);
      const error = new Error("TikTok video init returned an error");
      (error as any).code = "TIKTOK_INIT_ERROR";
      throw error;
    }

    const uploadUrl = initJson?.data?.upload_url as string | undefined;
    const publishId = initJson?.data?.publish_id as string | undefined;

    if (!uploadUrl || !publishId) {
      console.error("[TikTok] video init missing upload_url or publish_id", initJson);
      const error = new Error("TikTok did not return upload_url or publish_id");
      (error as any).code = "TIKTOK_INIT_MISSING_FIELDS";
      throw error;
    }

    console.log('[TikTok] Got upload URL, uploading video in chunks...', {
      totalChunks,
      chunkSize: CHUNK_SIZE,
    });

    // Upload video in chunks
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, size);
      const chunk = fileBytes.slice(start, end);
      
      console.log(`[TikTok] Uploading chunk ${chunkIndex + 1}/${totalChunks}`, {
        bytes: `${start}-${end-1}/${size}`,
      });

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${start}-${end-1}/${size}`,
          "Content-Type": mediaItem.mimeType,
        },
        body: chunk,
      });

      if (!uploadRes.ok) {
        console.error("[TikTok] chunk upload failed", {
          chunkIndex,
          status: uploadRes.status,
          statusText: uploadRes.statusText,
        });
        const error = new Error(`Failed to upload chunk ${chunkIndex + 1}/${totalChunks} to TikTok`);
        (error as any).code = "TIKTOK_UPLOAD_FAILED";
        throw error;
      }
      
      console.log(`[TikTok] Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully`);
    }

    console.log('[TikTok] Video uploaded successfully with Direct Post API', {
      publishId,
      captionIncluded: true,
      captionSent: tiktokCaption.substring(0, 100) + (tiktokCaption.length > 100 ? '...' : ''),
      note: 'Using Direct Post API with captions. In sandbox mode (privacy_level: SELF_ONLY), videos post with full captions but are only visible to you for testing.',
    });

    return {
      externalPostId: publishId,
    };
  },
};
