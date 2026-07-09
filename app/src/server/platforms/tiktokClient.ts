import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

import type { PlatformClient, PublishContext, PublishResult, TikTokCreatorInfo } from "./types";

/** Minimal shape of TikTok's creator_info response (only the fields we read). */
interface TikTokCreatorInfoResponse {
  data?: {
    creator_username?: string;
    creator_avatar_url?: string;
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  };
}

/** post_info payload sent to TikTok's video/init endpoint. */
interface TikTokPostInfo {
  title: string;
  privacy_level: string;
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
  video_cover_timestamp_ms: number;
  disclosure_settings?: { disclosure_type: string };
  brand_organic_type?: string;
  brand_content_type?: string;
}

/** Minimal shape of TikTok's video/init response (only the fields we read). */
interface TikTokInitResponse {
  data?: { publish_id?: string; upload_url?: string };
  error?: { code?: string };
}

const TIKTOK_API_BASE = "https://open.tiktokapis.com";

/** Max bytes per TikTok FILE_UPLOAD chunk (TikTok allows 5MB to 64MB; we use 10MB). */
export const TIKTOK_MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * TikTok's hard cap on the FINAL (merged) chunk. With a 10MB base chunk the
 * final chunk is always under 20MB, so this is only a sanity bound.
 */
export const TIKTOK_MAX_FINAL_CHUNK_SIZE = 128 * 1024 * 1024; // 128MB

/** A half-open byte range [start, end) for one uploaded chunk. */
export interface ChunkRange {
  /** Inclusive start byte offset. */
  start: number;
  /** Exclusive end byte offset (the last byte sent is end - 1). */
  end: number;
}

export interface ChunkPlan {
  /** Value sent as source_info.chunk_size. */
  chunkSize: number;
  /** Value sent as source_info.total_chunk_count (TikTok's floor rule). */
  totalChunks: number;
  /** Contiguous byte ranges to PUT; ranges.length === totalChunks. */
  ranges: ChunkRange[];
}

/**
 * Compute the TikTok FILE_UPLOAD chunk plan for a video of `size` bytes.
 *
 * TikTok's contract: chunk_size is capped (10MB here), total_chunk_count is
 * floor(size / chunk_size), every chunk except the last is exactly chunk_size
 * bytes, and the FINAL chunk absorbs the trailing size % chunk_size bytes (so
 * it may be up to nearly 2x chunk_size, but never above TikTok's 128MB
 * final-chunk cap for chunk sizes at or below 64MB). A file at or below
 * chunk_size uploads as a single whole-file chunk.
 *
 * This is the fix for the trailing-byte data loss: the final range ends at
 * `size`, not `start + chunkSize`.
 */
export function computeChunkPlan(
  size: number,
  maxChunkSize: number = TIKTOK_MAX_CHUNK_SIZE,
): ChunkPlan {
  const chunkSize = Math.min(size, maxChunkSize);
  const totalChunks = size <= maxChunkSize ? 1 : Math.floor(size / chunkSize);

  const ranges: ChunkRange[] = [];
  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkSize;
    // The final chunk extends to `size`, absorbing any trailing bytes that a
    // fixed `start + chunkSize` cap would otherwise drop.
    const end = index === totalChunks - 1 ? size : start + chunkSize;
    ranges.push({ start, end });
  }

  return { chunkSize, totalChunks, ranges };
}

/** Terminal/transient classification of a single TikTok publish-status poll. */
export type PollOutcome = "complete" | "failed" | "pending";

/**
 * Pure decision for one publish-status poll result. Only "publish_complete" is
 * success and only "failed" is terminal; every other status
 * ("processing_upload", "processing_download", unknown, or missing) is still
 * pending, so the caller should keep polling.
 */
export function decidePollOutcome(status: string | null | undefined): PollOutcome {
  if (status === "publish_complete") return "complete";
  if (status === "failed") return "failed";
  return "pending";
}

/**
 * Fetch TikTok creator info - REQUIRED by TikTok Developer Guidelines
 * Must be called before posting to get privacy options, interaction settings, and posting limits
 */
export async function getTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const response = await fetchWithTimeout(`${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  await assertOk(response, {
    code: "TIKTOK_CREATOR_INFO_FAILED",
    prefix: "Failed to fetch TikTok creator info",
  });

  const json = await response.json() as TikTokCreatorInfoResponse;
  const data = json?.data;

  if (!data) {
    throw new Error("TikTok creator_info returned no data");
  }

  return {
    creatorUsername: data.creator_username || "Unknown",
    creatorAvatarUrl: data.creator_avatar_url || "",
    privacyLevelOptions: data.privacy_level_options || ["SELF_ONLY"],
    commentDisabled: data.comment_disabled || false,
    duetDisabled: data.duet_disabled || false,
    stitchDisabled: data.stitch_disabled || false,
    maxVideoPostDurationSec: data.max_video_post_duration_sec || 60,
  };
}

export const tiktokClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem, caption } = ctx;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for TikTok") as Error & { code: string };
      error.code = "TIKTOK_NO_ACCESS_TOKEN";
      throw error;
    }

    // REQUIRED: Call creator_info API before posting to verify account status
    // This is mandatory per TikTok Developer Guidelines
    console.log('[TikTok] Fetching creator info to verify account status...');
    try {
      const creatorInfo = await getTikTokCreatorInfo(accessToken);
      console.log('[TikTok] Creator info retrieved:', {
        username: creatorInfo.creatorUsername,
        privacyOptions: creatorInfo.privacyLevelOptions,
        maxDuration: creatorInfo.maxVideoPostDurationSec,
      });
      
      // Verify the account has the required privacy options for sandbox mode
      if (!creatorInfo.privacyLevelOptions.includes('SELF_ONLY')) {
        console.warn('[TikTok] Account may not support SELF_ONLY privacy level', {
          availableOptions: creatorInfo.privacyLevelOptions,
        });
      }
    } catch (creatorInfoError: unknown) {
      console.error('[TikTok] Failed to fetch creator info:', creatorInfoError);
      const cause = creatorInfoError as Error & { code?: string };
      const error = new Error(
        `TikTok creator_info check failed: ${cause.message}`,
      ) as Error & { code: string };
      error.code = cause.code ?? "TIKTOK_CREATOR_INFO_FAILED";
      throw error;
    }

    console.log('[TikTok] Media item details:', {
      mimeType: mediaItem.mimeType,
      originalFilename: mediaItem.originalFilename,
      storageLocation: mediaItem.storageLocation,
    });

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("video/")) {
      const error = new Error(`TikTok requires video files. Current mime type: ${mediaItem.mimeType || 'undefined'}`) as Error & { code: string };
      error.code = "TIKTOK_MEDIA_NOT_VIDEO";
      throw error;
    }

    // Download video from Vercel Blob Storage.
    // fetchWithTimeout's own timeoutMs only bounds the connection + response
    // headers; pass AbortSignal.timeout as init.signal to also bound the
    // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
    const videoUrl = mediaItem.storageLocation;
    const videoResponse = await fetchWithTimeout(
      videoUrl,
      { signal: AbortSignal.timeout(120_000) },
      120_000,
    );
    await assertOk(videoResponse, {
      code: "TIKTOK_FETCH_VIDEO_FAILED",
      prefix: "Failed to fetch video from storage",
    });

    const fileBytes = Buffer.from(await videoResponse.arrayBuffer());
    const size = fileBytes.byteLength;

    // TikTok title has a 2200 character limit, but captions are typically shorter
    // Truncate if needed to avoid API rejection
    const tiktokCaption = caption 
      ? (caption.length > 2200 ? caption.substring(0, 2200) : caption)
      : "Video posted via Vibe Socials";

    // TikTok FILE_UPLOAD chunking (see computeChunkPlan): chunk_size is capped at
    // 10MB, total_chunk_count is floor(size / chunk_size), and the FINAL chunk
    // absorbs the trailing bytes so the entire file is uploaded.
    const { chunkSize: CHUNK_SIZE, totalChunks, ranges } = computeChunkPlan(size);

    console.log('[TikTok] Initializing upload with FILE_UPLOAD (chunked)', {
      videoSize: size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      hasAccessToken: !!accessToken,
      captionPreview: tiktokCaption.substring(0, 100) + (tiktokCaption.length > 100 ? '...' : ''),
    });

    // Use metadata from user's form selections, or defaults for sandbox mode
    const tiktokMeta = ctx.tiktokMetadata;
    const postInfo: TikTokPostInfo = {
      title: tiktokCaption,
      privacy_level: tiktokMeta?.privacyLevel || "SELF_ONLY",
      disable_comment: tiktokMeta?.disableComment ?? false,
      disable_duet: tiktokMeta?.disableDuet ?? false,
      disable_stitch: tiktokMeta?.disableStitch ?? false,
      video_cover_timestamp_ms: 1000,
    };

    // Add commercial content disclosure if specified
    if (tiktokMeta?.brandedContent || tiktokMeta?.brandOrganic) {
      postInfo.disclosure_settings = {
        disclosure_type: "BRANDED_CONTENT",
      };
      if (tiktokMeta.brandOrganic) {
        postInfo.brand_organic_type = "CREATOR_BRAND";
      }
      if (tiktokMeta.brandedContent) {
        postInfo.brand_content_type = "BRANDED_CONTENT";
      }
    }

    // Use Direct Post API with FILE_UPLOAD and captions
    const initRes = await fetchWithTimeout(
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
      30_000,
    );

    await assertOk(initRes, {
      code: "TIKTOK_INIT_FAILED",
      prefix: "Failed to start TikTok video upload",
    });

    const initJson = (await initRes.json().catch(() => null)) as TikTokInitResponse | null;
    const initErrorCode = initJson?.error?.code;
    if (initErrorCode && initErrorCode !== "ok") {
      console.error("[TikTok] video init error payload", initJson);
      const error = new Error("TikTok video init returned an error") as Error & { code: string };
      error.code = "TIKTOK_INIT_ERROR";
      throw error;
    }

    const uploadUrl = initJson?.data?.upload_url as string | undefined;
    const publishId = initJson?.data?.publish_id as string | undefined;

    if (!uploadUrl || !publishId) {
      console.error("[TikTok] video init missing upload_url or publish_id", initJson);
      const error = new Error("TikTok did not return upload_url or publish_id") as Error & { code: string };
      error.code = "TIKTOK_INIT_MISSING_FIELDS";
      throw error;
    }

    console.log('[TikTok] Got upload URL, uploading video in chunks...', {
      totalChunks,
      chunkSize: CHUNK_SIZE,
    });

    // Upload video in chunks. Each PUT's Content-Range reflects the ACTUAL bytes
    // sent; the final range ends at `size`, so no trailing bytes are dropped.
    for (const [chunkIndex, { start, end }] of ranges.entries()) {
      const chunk = fileBytes.subarray(start, end);

      console.log(`[TikTok] Uploading chunk ${chunkIndex + 1}/${totalChunks}`, {
        bytes: `${start}-${end - 1}/${size}`,
      });

      const uploadRes = await fetchWithTimeout(
        uploadUrl,
        {
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end - 1}/${size}`,
            "Content-Type": mediaItem.mimeType,
          },
          body: chunk,
        },
        120_000,
      );

      await assertOk(uploadRes, {
        code: "TIKTOK_UPLOAD_FAILED",
        prefix: `Failed to upload chunk ${chunkIndex + 1}/${totalChunks} to TikTok`,
      });

      console.log(`[TikTok] Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully`);
    }

    console.log('[TikTok] Video chunks uploaded, checking publish status...', { publishId });

    // Poll publish status to verify TikTok processed the video.
    // Terminal outcomes MUST escape this loop: a "failed" status or exhausting
    // every attempt without "publish_complete" throws (so the job records a
    // failure) - only a real "publish_complete" returns success. Transient
    // fetch/parse errors within a single iteration are logged and retried; they
    // must NOT be mistaken for a terminal outcome.
    const maxAttempts = 10;
    let completed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3s between checks

      let publishStatus: string | undefined;
      try {
        const statusRes = await fetchWithTimeout(
          `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ publish_id: publishId }),
          },
          30_000,
        );

        if (!statusRes.ok) {
          // Transient HTTP error: log and retry on the next iteration.
          console.warn(`[TikTok] Status check ${attempt + 1}/${maxAttempts} HTTP ${statusRes.status}`);
          continue;
        }

        const statusJson = (await statusRes.json()) as {
          data?: { status?: string };
        };
        publishStatus = statusJson?.data?.status;
      } catch (statusError) {
        // Transient fetch/parse error: log and retry on the next iteration.
        const message =
          statusError instanceof Error ? statusError.message : String(statusError);
        console.warn(`[TikTok] Status check ${attempt + 1} failed:`, message);
        continue;
      }

      // Decide OUTSIDE the try/catch above so terminal outcomes are not
      // swallowed by the transient-error handler.
      const decision = decidePollOutcome(publishStatus);
      if (decision === "complete") {
        console.log('[TikTok] Video published successfully', {
          publishId,
          privacyLevel: postInfo.privacy_level,
          note: 'In sandbox mode, videos are forced to SELF_ONLY (private) visibility. Check your private posts in TikTok.',
        });
        completed = true;
        break;
      }
      if (decision === "failed") {
        const error = new Error("TikTok failed to process the video") as Error & {
          code: string;
        };
        error.code = "TIKTOK_PUBLISH_FAILED";
        throw error;
      }

      // Still pending ("processing_upload" / "processing_download" / unknown).
      console.log(`[TikTok] Status check ${attempt + 1}/${maxAttempts}:`, {
        status: publishStatus ?? "unknown",
        publishId,
      });
    }

    if (!completed) {
      // Poll exhausted without a terminal "publish_complete": treat as failure
      // rather than silently returning success for a video we never confirmed.
      console.warn('[TikTok] Publish status not confirmed before timeout', {
        publishId,
        note: 'Video may still be processing on TikTok.',
      });
      const error = new Error(
        "TikTok did not confirm publish completion in time; the video may still be processing",
      ) as Error & { code: string };
      error.code = "TIKTOK_PUBLISH_TIMEOUT";
      throw error;
    }

    return {
      externalPostId: publishId,
    };
  },
};
