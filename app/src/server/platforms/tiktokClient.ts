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

    console.log('[TikTok] Initializing upload with FILE_UPLOAD', {
      videoSize: size,
      hasAccessToken: !!accessToken,
      accessTokenLength: accessToken?.length,
      captionPreview: tiktokCaption.substring(0, 100) + (tiktokCaption.length > 100 ? '...' : ''),
    });

    // Use Inbox API - Direct Post API requires URL ownership verification
    // Inbox workflow: Upload → Video goes to Creator Portal inbox → Manual caption/publish
    const initRes = await fetch(
      `${TIKTOK_API_BASE}/v2/post/publish/inbox/video/init/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: size,
            total_chunk_count: 1,
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

    console.log('[TikTok] Got upload URL, uploading video bytes...');

    const endByte = size > 0 ? size - 1 : 0;

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes 0-${endByte}/${size}`,
        "Content-Type": mediaItem.mimeType,
      },
      body: fileBytes,
    });

    if (!uploadRes.ok) {
      console.error("[TikTok] video upload failed", {
        status: uploadRes.status,
        statusText: uploadRes.statusText,
      });
      const error = new Error("Failed to upload video bytes to TikTok");
      (error as any).code = "TIKTOK_UPLOAD_FAILED";
      throw error;
    }

    console.log('[TikTok] Video uploaded successfully to Creator Portal inbox', {
      publishId,
      note: 'Video is in your TikTok Creator Portal inbox. You can add captions and publish manually from the TikTok app. Caption sent: ' + tiktokCaption.substring(0, 100) + '...',
      workflow: 'Inbox API (upload draft for manual editing)',
    });

    return {
      externalPostId: publishId,
    };
  },
};
