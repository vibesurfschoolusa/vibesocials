import type { Platform } from "@prisma/client";

import { pageWorkspaceRefusalText } from "@/lib/workspaceChanged";
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
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { storyVideoLengthRefusal, type PlacementChoiceValue } from "@/lib/storyPlacement";
import { explainUploadFailure, UploadRefusedError } from "@/lib/uploadFailure";
import type { coverRequestFields } from "@/lib/videoCover";
import type { GoogleBusinessPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";

/**
 * Add many's share of what makes Create pleasant (P1 parity): Improve, the
 * photo description, the video cover, Google options and Feed or
 * Story. Each one reuses Create's own request field and helper, so a batch
 * post is the post Create would have made.
 */

/** The one line under the caption box when Improve got no new caption. */
export const BULK_IMPROVE_FAILED_TEXT =
  "The caption was not improved and is as it was. Try again, or edit it yourself.";

/** Lead review 3 (R28 NN2): on a lost answer the AI ran and used the allowance; only its answer is missing, and nothing is saved. */
export const BULK_IMPROVE_LOST_TEXT = answerLostText(
  "the improved caption isn't shown",
  "The caption is as it was; try again, or edit it yourself.",
);
export const BULK_CAPTION_LOST_TEXT = answerLostText(
  "the caption isn't shown",
  "Nothing was saved; ask again, or write one yourself.",
);

/** The cover upload failed: Create's own sentence. */
export const BULK_COVER_FAILED_TEXT =
  "The cover image could not be uploaded. Try again, or choose Platform default.";

/**
 * What a failed cover upload says, on Create and in Add many (R21
 * publishing-flow L1): the reason explainUploadFailure finds (signed out,
 * storage full, the upload refused), else the cover sentence.
 */
export async function coverUploadFailedText(
  error: unknown,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const explained = await explainUploadFailure(error, workspaceId, fetchImpl);
  return explained instanceof UploadRefusedError ? explained.message : BULK_COVER_FAILED_TEXT;
}

/**
 * Why Improve got no new caption, by the answer's status, the way
 * captionFailedText says it for a caption (`status` null: no answer at all).
 * The server's own text stays in the console.
 */
export function improveFailedText(status: number | null, code: unknown): string {
  if (status === 401) return SIGNED_OUT_ERROR;
  // R31: a page for another workspace, or from before the release.
  const workspaceText = pageWorkspaceRefusalText(code);
  if (workspaceText) return workspaceText;
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
  /** R31: the workspace the page was drawn for (null: none yet, left out). */
  workspaceId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BulkImproveResult> {
  try {
    const response = await fetchOrNoAnswer(
      "/api/posts/enhance-caption",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption, ...(workspaceId ? { workspaceId } : {}) }),
      },
      fetchImpl,
    );
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
    return { ok: false, error: isNoAnswer(error) ? BULK_IMPROVE_LOST_TEXT : BULK_IMPROVE_FAILED_TEXT };
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

/** An AI switch read live: Create's "Generate a caption when media is added", Add many's "Write captions with AI". */
export interface AiSwitch {
  readonly current: boolean;
}

/**
 * R39 publishing L1: the one place an automatic AI request reads its switch.
 * Each asks right before its fetch, after any local work (a frame grab, the
 * caption before a description), so unticking meanwhile sends nothing more.
 */
export function aiSwitchOn(aiSwitch: AiSwitch): boolean {
  return aiSwitch.current;
}

/**
 * A row's caption step, then its automatic description whatever the caption's
 * outcome (a failed caption still gets one). `describe` marks the row asked,
 * so Write again does not describe it a second time.
 *
 * F7 (R1 M2): with "Write captions with AI" off (`ai: false`), nothing goes to
 * the AI: only `withoutAi` runs, which reads what the row needs from its own
 * file (a video's length and thumbnail) and leaves the caption box empty.
 */
export async function captionThenDescribe(
  id: string,
  steps: {
    writeCaption(id: string): Promise<void>;
    row(id: string): AltTextRowState | undefined;
    describe(id: string): Promise<void>;
    withoutAi?(id: string): Promise<void>;
  },
  { ai }: { ai: boolean } = { ai: true },
): Promise<void> {
  if (!ai) {
    await steps.withoutAi?.(id);
    return;
  }
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
export async function describePhotoOnce(
  blob: UploadedBlob,
  workspaceId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    return await requestPhotoDescription(blob, workspaceId, fetchImpl);
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
  /** R31: the workspace the page was drawn for (null: none yet, left out). */
  workspaceId: string | null,
): { blobUrl: string; mimeType: string; bulk: true; frames?: string[]; avoidCaptions?: string[]; workspaceId?: string } {
  const avoidCaptions = siblingCaptions(rows, id);
  return {
    blobUrl: blob.url,
    mimeType: blob.mimeType,
    bulk: true,
    ...(frames.length > 0 ? { frames: [...frames] } : {}),
    ...(avoidCaptions.length > 0 ? { avoidCaptions } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * The batch's choice, per platform: false for Feed, true for Story, "both"
 * for Feed and Story (Q1). The Story rules apply to true and "both" alike.
 */
export interface BulkStories {
  instagram: boolean | "both";
  facebook: boolean | "both";
}

/** The batch's placement choice as BulkStories holds it. */
export function bulkStoryChoice(placement: PlacementChoiceValue): boolean | "both" {
  return placement === "both" ? "both" : placement === "story";
}

/** A row's request field for its batch choice. */
function storyField(choice: boolean | "both"): { placement: "story" | "both" } {
  return { placement: choice === "both" ? "both" : "story" };
}

/**
 * What a created row says. A Feed and Story row (the answer names its Story
 * job) says so; a held row says "Sent for approval" whatever it holds.
 */
export function bulkRowResultText(input: { heldForApproval: boolean; mode: "schedule" | "draft"; body: unknown }): string {
  if (input.heldForApproval) return "Sent for approval";
  const storyPostJobId = (input.body as { storyPostJobId?: unknown } | null)?.storyPostJobId;
  const feedAndStory = typeof storyPostJobId === "string" && storyPostJobId !== "";
  if (input.mode === "draft") return feedAndStory ? "Saved as drafts (feed and Story)" : "Saved as a draft";
  return feedAndStory ? "Scheduled (feed and Story)" : "Scheduled";
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
  googleMetadata: GoogleBusinessPostMetadata;
  stories: BulkStories;
  /** coverRequestFields for this row's video once its image is uploaded; {} for none. */
  coverFields: ReturnType<typeof coverRequestFields>;
}

/** One row's body: Create's upload or reuse body plus the fields Create adds beside it. */
export type BulkRowBody = (CreatePostRequest | CreatePostReuseRequest) & {
  altText?: string;
  instagramMetadata?: { placement: "story" | "both" };
  facebookMetadata?: { placement: "story" | "both" };
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
      ? { instagramMetadata: storyField(input.stories.instagram) }
      : {}),
    ...(input.stories.facebook && platforms.includes("facebook_page")
      ? { facebookMetadata: storyField(input.stories.facebook) }
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

/** Where this browser keeps Add many's "Write captions with AI" choice (F7). */
export const AI_CAPTIONS_STORAGE_KEY = "vibe.bulkAiCaptions";

type ChoiceStorage = Partial<Pick<Storage, "getItem" | "setItem">>;

/**
 * Whether Add many writes captions with AI, as this browser last chose. On
 * unless it was turned off here; storage that is missing, blocked (reading
 * `window.localStorage` itself throws in some private windows) or holds
 * anything else reads as on.
 */
export function readAiCaptionsChoice(getStorage: () => ChoiceStorage | null | undefined): boolean {
  try {
    return getStorage()?.getItem?.(AI_CAPTIONS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Remembers the choice; a storage failure only means it is not remembered. */
export function saveAiCaptionsChoice(getStorage: () => ChoiceStorage | null | undefined, on: boolean): void {
  try {
    getStorage()?.setItem?.(AI_CAPTIONS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; the switch still works on this page.
  }
}
