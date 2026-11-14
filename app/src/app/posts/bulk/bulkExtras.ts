import type { Platform } from "@prisma/client";

import { requestPhotoDescription, withPhotoDescriptions } from "@/components/composer/attached-photos";
import {
  buildReusePostBody,
  buildUploadPostBody,
  type CreatePostRequest,
  type CreatePostReuseRequest,
  type DeferredPostFields,
  type UploadedBlob,
} from "@/lib/createPostRequest";
import { parseGooglePostMetadata, type GoogleButton } from "@/lib/googlePostOptions";
import { storyVideoLengthRefusal } from "@/lib/storyPlacement";
import type { coverRequestFields } from "@/lib/videoCover";
import type { GoogleBusinessPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";

/**
 * Add many's share of what makes Create pleasant (P1 parity): Improve, the
 * photo description, the video cover, location, Google options and Feed or
 * Story. Each one reuses Create's own request field and helper, so a batch
 * post is the post Create would have made.
 */

/** The one line under the caption box when Improve got no new caption. */
export const BULK_IMPROVE_FAILED_TEXT =
  "The caption was not improved and is as it was. Try again, or edit it yourself.";

/** The cover upload failed: Create's own sentence. */
export const BULK_COVER_FAILED_TEXT =
  "The cover image could not be uploaded. Try again, or choose Platform default.";

/**
 * Why Improve got no new caption, by the answer's status, the way
 * captionFailedText says it for a caption (`status` null: no answer at all).
 * The server's own text stays in the console.
 */
export function improveFailedText(status: number | null, code: unknown): string {
  if (status === 429 && code === "AI_WORKSPACE_DAILY_LIMIT") {
    return "The caption was not improved: your workspace has reached today's AI limit. Try again tomorrow, or edit it yourself.";
  }
  if (status === 429) {
    return "The caption was not improved: too many requests. Wait a few minutes, then try again.";
  }
  if (status === 403) {
    return "The caption was not improved: this workspace can't use AI right now. See the notice at the top of the page.";
  }
  // Improve is offered only for a caption with text, so a 400 is the length cap.
  if (status === 413 || status === 400) {
    return "The caption was not improved: it is too long to improve. Shorten it, or edit it yourself.";
  }
  return BULK_IMPROVE_FAILED_TEXT;
}

export type BulkImproveResult = { ok: true; caption: string } | { ok: false; error: string };

/** "Improve": the caption sent to POST /api/posts/enhance-caption exactly as Create sends it. */
export async function requestImprovedCaption(
  caption: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BulkImproveResult> {
  try {
    const response = await fetchImpl("/api/posts/enhance-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    });
    const data = (await response.json().catch(() => null)) as
      | { enhancedCaption?: unknown; error?: unknown; code?: unknown }
      | null;
    if (!response.ok || typeof data?.enhancedCaption !== "string" || !data.enhancedCaption.trim()) {
      // The server's own text stays in the console, as for a failed caption.
      console.error("[Add many] Improve failed", { status: response.status, code: data?.code, error: data?.error });
      return { ok: false, error: improveFailedText(response.ok ? null : response.status, data?.code) };
    }
    return { ok: true, caption: data.enhancedCaption };
  } catch (error: unknown) {
    console.error("[Add many] Improve failed", error);
    return { ok: false, error: BULK_IMPROVE_FAILED_TEXT };
  }
}

/** What deciding on an automatic description needs to know about a row. */
export interface AltTextRowState {
  mimeType: string;
  uploaded: boolean;
  /** Set for a Media item: never described automatically. */
  mediaItemId: string | null;
  altTextAsked: boolean;
}

/**
 * One automatic description per photo from the computer per batch: asked once
 * its file is stored, never for a video, never again. Never for a Media photo:
 * its saved description is not in the Media list, and a sent altText replaces
 * it, so it is described only when the user asks.
 */
export function wantsAltText(row: AltTextRowState): boolean {
  return row.mimeType.startsWith("image/") && row.uploaded && row.mediaItemId === null && !row.altTextAsked;
}

/**
 * A row's caption step, then its automatic description whatever the caption's
 * outcome (a failed caption still gets one). `describe` marks the row asked,
 * so Write again does not describe it a second time.
 */
export async function captionThenDescribe(
  id: string,
  steps: {
    writeCaption(id: string): Promise<void>;
    row(id: string): AltTextRowState | undefined;
    describe(id: string): Promise<void>;
  },
): Promise<void> {
  try {
    await steps.writeCaption(id);
  } finally {
    const row = steps.row(id);
    if (row && wantsAltText(row)) await steps.describe(id);
  }
}

/**
 * The photo's description from the AI, as Create's "Write it for me" asks for
 * it. Optional, so a failure is an empty description and nothing to show.
 */
export async function describePhotoOnce(blob: UploadedBlob, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    return await requestPhotoDescription(blob, fetchImpl);
  } catch (error: unknown) {
    console.error("[Add many] Photo description failed", error);
    return "";
  }
}

/** The auto-caption route takes at most this many sibling captions, each at most this long. */
const AVOID_MAX = 10;
const AVOID_LENGTH = 300;

/** Captions already written for the other rows, so the AI does not repeat them. */
export function siblingCaptions(rows: readonly { id: string; caption: string }[], ownId: string): string[] {
  return rows
    .filter((row) => row.id !== ownId)
    .map((row) => row.caption.trim())
    .filter(Boolean)
    .slice(0, AVOID_MAX)
    .map((caption) => caption.slice(0, AVOID_LENGTH));
}

/**
 * The POST /api/posts/auto-caption body for one row. `rows` must be the rows as
 * they are when the request is sent (rowsRef.current): rows are captioned one
 * at a time in order, so each one then sees the captions written just before it.
 */
export function autoCaptionRequestBody(
  rows: readonly { id: string; caption: string }[],
  id: string,
  blob: { url: string; mimeType: string },
  frames: readonly string[],
): { blobUrl: string; mimeType: string; bulk: true; frames?: string[]; avoidCaptions?: string[] } {
  const avoidCaptions = siblingCaptions(rows, id);
  return {
    blobUrl: blob.url,
    mimeType: blob.mimeType,
    bulk: true,
    ...(frames.length > 0 ? { frames: [...frames] } : {}),
    ...(avoidCaptions.length > 0 ? { avoidCaptions } : {}),
  };
}

/** The batch's Feed or Story choice, per platform. */
export interface BulkStories {
  instagram: boolean;
  facebook: boolean;
}

interface StoryRowInput {
  mimeType: string;
  /** The video's length once read; null or undefined when unknown (the platform decides, as on Create). */
  durationSec: number | null | undefined;
  /** The platforms this row goes to (platformsForRow). */
  platforms: readonly Platform[];
  stories: BulkStories;
}

/** Why this row cannot be the Story chosen for the batch, or null. Each row is one file, so only length matters. */
export function rowStoryRefusal(row: StoryRowInput): string | null {
  if (!row.mimeType.startsWith("video/")) return null;
  const duration = row.durationSec ?? null;
  const instagram =
    row.stories.instagram && row.platforms.includes("instagram") ? storyVideoLengthRefusal("instagram", duration) : null;
  const facebook =
    row.stories.facebook && row.platforms.includes("facebook_page")
      ? storyVideoLengthRefusal("facebook_page", duration)
      : null;
  return instagram ?? facebook;
}

/** Google options as Create starts them: an update with the workspace's default button. */
export function initialBulkGoogleMetadata(defaultButton: GoogleButton | null | undefined): GoogleBusinessPostMetadata {
  return defaultButton ? { postType: "update", button: defaultButton } : { postType: "update" };
}

/** The sentence POST /api/posts would refuse the batch's Google options with, or null. */
export function bulkGoogleMetadataError(metadata: GoogleBusinessPostMetadata): string | null {
  const parsed = parseGooglePostMetadata(metadata);
  return parsed.ok ? null : parsed.error;
}

/** Why this row is not sent on a press, beyond rowSendBlock: a Story it cannot be, or Google options the server refuses. */
export function bulkExtrasBlock(row: StoryRowInput & { googleError: string | null }): string | null {
  const story = rowStoryRefusal(row);
  if (story) return story;
  if (row.googleError && row.mimeType.startsWith("image/") && row.platforms.includes("google_business_profile")) {
    return row.googleError;
  }
  return null;
}

/** What building one row's body needs to know about the row. */
export interface BulkBodyRow {
  mimeType: string;
  blob: UploadedBlob;
  mediaItemId: string | null;
  caption: string;
  altText: string;
}

export interface BulkRowBodyInput {
  row: BulkBodyRow;
  platforms: Platform[];
  deferred: DeferredPostFields;
  workspaceId: string;
  youtubePrivacy: YouTubePostMetadata["privacyStatus"];
  location: string;
  googleMetadata: GoogleBusinessPostMetadata;
  stories: BulkStories;
  /** coverRequestFields for this row's video once its image is uploaded; {} for none. */
  coverFields: ReturnType<typeof coverRequestFields>;
}

/** One row's body: Create's upload or reuse body plus the fields Create adds beside it. */
export type BulkRowBody = (CreatePostRequest | CreatePostReuseRequest) & {
  altText?: string;
  instagramMetadata?: { placement: "story" };
  facebookMetadata?: { placement: "story" };
} & ReturnType<typeof coverRequestFields>;

/**
 * One row's POST /api/posts body: Create's builders (upload or Media reuse),
 * then the fields Create adds beside them (alt text, Story, cover).
 */
export function buildBulkRowBody(input: BulkRowBodyInput): BulkRowBody {
  const { row, platforms } = input;
  const isPhoto = row.mimeType.startsWith("image/");
  const isVideo = row.mimeType.startsWith("video/");
  const common = {
    baseCaption: row.caption,
    location: input.location,
    platforms,
    deferred: input.deferred,
    workspaceId: input.workspaceId,
    // The same field Create sends, for every row that goes to YouTube.
    youtubeMetadata: platforms.includes("youtube") ? { privacyStatus: input.youtubePrivacy } : undefined,
    // As Create: a Google photo post carries its options; a video goes to the gallery.
    googleMetadata: isPhoto && platforms.includes("google_business_profile") ? input.googleMetadata : undefined,
  };
  // A Media item is posted by id: the server reads it for this workspace only.
  const body = row.mediaItemId
    ? buildReusePostBody({ ...common, mediaItemId: row.mediaItemId })
    : buildUploadPostBody({ ...common, blob: row.blob });
  return {
    ...withPhotoDescriptions(body, isPhoto ? [row.altText] : []),
    ...(input.stories.instagram && platforms.includes("instagram")
      ? { instagramMetadata: { placement: "story" as const } }
      : {}),
    ...(input.stories.facebook && platforms.includes("facebook_page")
      ? { facebookMetadata: { placement: "story" as const } }
      : {}),
    ...(isVideo ? input.coverFields : {}),
  };
}

/** A video's length in seconds, read from its metadata in the browser; null when it can't be read in time. */
export function readVideoDuration(source: File | string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
    // Called only after `timer` below is set: the video starts loading after it.
    const finish = (value: number | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(value);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.src = objectUrl ?? (source as string);
  });
}
