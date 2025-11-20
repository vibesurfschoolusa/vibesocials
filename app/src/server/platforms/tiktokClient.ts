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

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("video/")) {
      const error = new Error("TikTok publishing currently supports video files only.");
      (error as any).code = "TIKTOK_MEDIA_NOT_VIDEO";
      throw error;
    }

    // Fetch the video file from Vercel Blob (storageLocation is now a URL)
    const videoUrl = mediaItem.storageLocation;
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      const error = new Error("Failed to fetch video from storage");
      (error as any).code = "TIKTOK_FETCH_VIDEO_FAILED";
      throw error;
    }
    
    const fileBytes = Buffer.from(await videoResponse.arrayBuffer());
    const size = fileBytes.byteLength;

    console.log('[TikTok] Initializing upload', {
      videoSize: size,
      hasAccessToken: !!accessToken,
      accessTokenLength: accessToken?.length,
    });

    const initRes = await fetch(
      `${TIKTOK_API_BASE}/v2/post/publish/inbox/video/init/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          post_info: {
            title: caption || "Video posted via Vibe Social Sync",
            privacy_level: "SELF_ONLY", // Sandbox requires SELF_ONLY
            disable_comment: false,
            disable_duet: false,
            disable_stitch: false,
            video_cover_timestamp_ms: 1000,
          },
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

    return {
      externalPostId: publishId,
    };
  },
};
