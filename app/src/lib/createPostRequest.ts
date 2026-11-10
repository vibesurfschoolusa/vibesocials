import type { Platform } from "@prisma/client";

import { cleanPlatformOverrides } from "@/lib/platformOverrides";
import type {
  GoogleBusinessPostMetadata,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";

/**
 * The two `POST /api/posts` request bodies the composer sends, as pure builders.
 *
 * 2026-11-01 audit (M3) + final review (T9): both carry `workspaceId`, the id of
 * the workspace the composer page was rendered for. The active workspace is a
 * cookie shared by every tab, so the server compares this id with the cookie's
 * workspace and refuses (409 WORKSPACE_CHANGED) when a switch in another tab
 * made them differ. The route keeps the field optional so API clients that don't
 * send it still work, but the composer must always send it: `workspaceId` is
 * REQUIRED here, so the compiler rejects a caller (or a future new body) that
 * forgets it, and the tests pin it into both bodies.
 */

// Fields shared by both create bodies for the deferred modes (Roadmap Phase 5).
export interface DeferredPostFields {
  /** Present + true → save as draft. */
  draft?: boolean;
  /** Present → schedule for this UTC ISO time. */
  scheduledFor?: string;
}

// Fields shared by both create bodies.
interface CreatePostBodyBase extends DeferredPostFields {
  /** The workspace this page was rendered for (see the file comment). */
  workspaceId: string;
  baseCaption: string;
  location?: string;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  googleMetadata?: GoogleBusinessPostMetadata;
  /** Task 7 — chosen subset of connected platforms to publish to. */
  platforms?: Platform[];
  /** A different caption per platform; left out when there is none. */
  perPlatformOverrides?: Partial<Record<Platform, string>>;
}

// Request body for a freshly uploaded file.
export interface CreatePostRequest extends CreatePostBodyBase {
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

// Roadmap Phase 2 — request body for the reuse path: an already-persisted
// MediaItem instead of a fresh blobUrl upload. POST /api/posts branches on which
// of blobUrl / mediaItemId is present.
export interface CreatePostReuseRequest extends CreatePostBodyBase {
  mediaItemId: string;
}

interface CommonBodyInput {
  baseCaption: string;
  /** Raw location input; trimmed here, and left out of the body when blank. */
  location: string;
  platforms: Platform[];
  deferred: DeferredPostFields;
  workspaceId: string;
  /** Pass only when TikTok is a selected target. */
  tiktokMetadata?: TikTokPostMetadata;
  /** Pass only when YouTube is a selected target. */
  youtubeMetadata?: YouTubePostMetadata;
  /** Pass only when Google Business Profile is a selected target for a photo. */
  googleMetadata?: GoogleBusinessPostMetadata;
  /**
   * Per-platform captions as the user typed them. Only selected, non-blank ones
   * that differ from the main caption are sent (`cleanPlatformOverrides`);
   * when none remain the field is left out.
   */
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}

export interface UploadedBlob {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface BuildUploadPostBodyInput extends CommonBodyInput {
  blob: UploadedBlob;
}

export interface BuildReusePostBodyInput extends CommonBodyInput {
  mediaItemId: string;
}

function overridesToSend(input: CommonBodyInput): Partial<Record<Platform, string>> | null {
  return cleanPlatformOverrides(input.perPlatformOverrides, input.baseCaption, input.platforms);
}

/** Body for posting a file the composer just uploaded to blob storage. */
export function buildUploadPostBody(input: BuildUploadPostBodyInput): CreatePostRequest {
  const body: CreatePostRequest = {
    blobUrl: input.blob.url,
    filename: input.blob.filename,
    mimeType: input.blob.mimeType,
    sizeBytes: input.blob.sizeBytes,
    baseCaption: input.baseCaption,
    location: input.location.trim() || undefined,
    platforms: input.platforms,
    ...input.deferred,
    workspaceId: input.workspaceId,
  };
  const perPlatformOverrides = overridesToSend(input);
  if (perPlatformOverrides) {
    body.perPlatformOverrides = perPlatformOverrides;
  }
  if (input.tiktokMetadata) {
    body.tiktokMetadata = input.tiktokMetadata;
  }
  if (input.youtubeMetadata) {
    body.youtubeMetadata = input.youtubeMetadata;
  }
  if (input.googleMetadata) {
    body.googleMetadata = input.googleMetadata;
  }
  return body;
}

/** Body for posting an already-persisted library item (no upload). */
export function buildReusePostBody(input: BuildReusePostBodyInput): CreatePostReuseRequest {
  const body: CreatePostReuseRequest = {
    mediaItemId: input.mediaItemId,
    baseCaption: input.baseCaption,
    location: input.location.trim() || undefined,
    platforms: input.platforms,
    ...input.deferred,
    workspaceId: input.workspaceId,
  };
  const perPlatformOverrides = overridesToSend(input);
  if (perPlatformOverrides) {
    body.perPlatformOverrides = perPlatformOverrides;
  }
  if (input.tiktokMetadata) {
    body.tiktokMetadata = input.tiktokMetadata;
  }
  if (input.youtubeMetadata) {
    body.youtubeMetadata = input.youtubeMetadata;
  }
  if (input.googleMetadata) {
    body.googleMetadata = input.googleMetadata;
  }
  return body;
}
