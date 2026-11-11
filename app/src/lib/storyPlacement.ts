import type { Platform } from "@prisma/client";

import { platformLabel } from "@/lib/platforms";

/**
 * Feed or Story for Instagram and Facebook (2026-11-10). One pure file for the
 * posts route and the Create page, so both apply the same rules.
 */

export type StoryPlacement = "feed" | "story";

/** The platforms that can take a Story. */
export type StoryPlatform = "instagram" | "facebook_page";

/** The request fields that carry the choice, one per platform. */
export type StoryPlacementField = "instagramMetadata" | "facebookMetadata";

/**
 * Longest Story video each platform takes, in seconds. Instagram: the IG User
 * Media reference, Story video "60 seconds maximum". Facebook: the Page Stories
 * API, video Stories "3 to 90 seconds". Both read 2026-11-10.
 */
export const STORY_VIDEO_LIMIT_SEC: Record<StoryPlatform, number> = {
  instagram: 60,
  facebook_page: 90,
};

/** Shortest Story video both pages allow: "3 seconds minimum" / "3 to 90 seconds". */
export const STORY_VIDEO_MIN_SEC = 3;

export type ParsedPlacement =
  | { ok: true; value: { placement: StoryPlacement } | undefined }
  | { ok: false; error: string };

/**
 * Read `instagramMetadata` / `facebookMetadata` from a request. Absent (or
 * null) is no choice, which means feed. Only `{ placement: "feed" | "story" }`
 * is accepted: any other shape or key is refused, naming the field.
 */
export function parsePlacementMetadata(value: unknown, field: StoryPlacementField): ParsedPlacement {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const error = `${field} must be { "placement": "feed" } or { "placement": "story" }.`;
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error };
  const keys = Object.keys(value);
  const placement = (value as { placement?: unknown }).placement;
  if (keys.length !== 1 || (placement !== "feed" && placement !== "story")) return { ok: false, error };
  return { ok: true, value: { placement } };
}

/** Why a Story cannot carry this many files, or null when it can. */
export function storyMediaRefusal(platform: StoryPlatform, fileCount: number): string | null {
  if (fileCount <= 1) return null;
  return `A Story takes one photo or video. Choose Feed for ${platformLabel(platform)}, or remove the extra photos.`;
}

/**
 * Why a Story cannot take a video this long (or this short), or null. Only the
 * browser knows the length; an unknown length (null) is allowed and the
 * platform decides.
 */
export function storyVideoLengthRefusal(platform: StoryPlatform, durationSec: number | null): string | null {
  if (durationSec === null || !Number.isFinite(durationSec)) return null;
  const label = platformLabel(platform);
  if (durationSec < STORY_VIDEO_MIN_SEC) {
    // Rounded down to a tenth, so a video just under the minimum never reads as equal to it.
    const length = Math.floor(durationSec * 10) / 10;
    return `${label} Stories need a video of at least ${STORY_VIDEO_MIN_SEC} seconds. This one is ${length} seconds.`;
  }
  const limit = STORY_VIDEO_LIMIT_SEC[platform];
  if (durationSec <= limit) return null;
  // Rounded up, so a video a fraction over the limit never reads as equal to it.
  return `${label} Stories take videos up to ${limit} seconds. This one is ${Math.ceil(durationSec)} seconds.`;
}

/**
 * The platforms a job sent as a Story, from its stored `publishMetadata`
 * (PublishMetadataSnapshot's `instagram` / `facebook`). A job without the
 * snapshot, or with anything but a Story there, has none.
 */
export function storyPlatformsOf(publishMetadata: unknown): StoryPlatform[] {
  if (typeof publishMetadata !== "object" || publishMetadata === null) return [];
  const snapshot = publishMetadata as { instagram?: { placement?: unknown }; facebook?: { placement?: unknown } };
  const platforms: StoryPlatform[] = [];
  if (snapshot.instagram?.placement === "story") platforms.push("instagram");
  if (snapshot.facebook?.placement === "story") platforms.push("facebook_page");
  return platforms;
}

/** What the approval email shows for a platform that publishes a Story. */
export const STORY_NO_CAPTION = "Story, no caption";

/**
 * The per-platform captions an approver is shown, with each Story platform
 * listed as {@link STORY_NO_CAPTION}: a Story publishes no caption, so no text
 * may be presented as going there. Returns the input unchanged without a Story.
 */
export function withStoryCaptions(
  platformCaptions: Partial<Record<Platform, string>> | null,
  storyPlatforms: readonly StoryPlatform[],
): Partial<Record<Platform, string>> | null {
  if (storyPlatforms.length === 0) return platformCaptions;
  const captions: Partial<Record<Platform, string>> = { ...platformCaptions };
  for (const platform of storyPlatforms) captions[platform] = STORY_NO_CAPTION;
  return captions;
}

/**
 * What the Create page holds for one platform. `returnedToFeed` is set when a
 * chosen Story went back to Feed because a second photo was attached, so the
 * page can say why.
 */
export interface PlacementChoice {
  placement: StoryPlacement;
  returnedToFeed: boolean;
}

export const FEED_CHOICE: PlacementChoice = { placement: "feed", returnedToFeed: false };

/**
 * Both platforms' choices as the Create page starts, and as it returns there
 * after a post is sent: Feed, so a Story never carries over to the next post.
 */
export function initialPlacements(): { instagram: PlacementChoice; facebook: PlacementChoice } {
  return { instagram: FEED_CHOICE, facebook: FEED_CHOICE };
}

/** The person picks Feed or Story. Story is refused while two or more photos are attached. */
export function choosePlacement(
  current: PlacementChoice,
  next: StoryPlacement,
  fileCount: number,
): PlacementChoice {
  if (next === "story" && fileCount > 1) return current;
  return { placement: next, returnedToFeed: false };
}

/**
 * Bring a choice in line with the attached files: a Story with two or more
 * photos goes back to Feed, so the page never sends what the server refuses.
 * Returns the same object when nothing changes.
 */
export function reconcilePlacement(current: PlacementChoice, fileCount: number): PlacementChoice {
  if (current.placement === "story" && fileCount > 1) return { placement: "feed", returnedToFeed: true };
  return current;
}

/** The line under the choice, or null when there is nothing to say. */
export function placementNote(platform: StoryPlatform, choice: PlacementChoice, fileCount: number): string | null {
  if (fileCount > 1) {
    return choice.returnedToFeed
      ? `A Story takes one photo or video, so this post goes to the ${platformLabel(platform)} feed.`
      : "A Story takes one photo or video.";
  }
  if (choice.placement === "story") {
    return `Stories show for 24 hours and have no caption. Your caption is not used on ${platformLabel(platform)}.`;
  }
  return null;
}

/** The line under the caption box while every selected platform is a Story. */
export const STORY_ONLY_CAPTION_NOTE = "Stories show no caption. This text is kept with the post but not published.";

/**
 * {@link STORY_ONLY_CAPTION_NOTE} when every selected platform publishes a
 * Story, else null. The caption stays required: the job keeps it, and the
 * Queue shows it and its edit route requires one.
 */
export function storyOnlyCaptionNote(
  selectedPlatforms: readonly Platform[],
  storyPlatforms: readonly Platform[],
): string | null {
  if (selectedPlatforms.length === 0) return null;
  return selectedPlatforms.every((platform) => storyPlatforms.includes(platform)) ? STORY_ONLY_CAPTION_NOTE : null;
}

/** A platform's name, with "(Story)" when the post sends it as a Story. */
export function storyPlatformLabel(platform: Platform, storyPlatforms: readonly Platform[]): string {
  return storyPlatforms.includes(platform) ? `${platformLabel(platform)} (Story)` : platformLabel(platform);
}

/**
 * How the Queue and the client review page list a post's platforms and own
 * captions once Stories are known. `storyOnly` is true when every target is a
 * Story, so the main caption is not published anywhere.
 */
export function storyListing(
  targetPlatforms: readonly Platform[],
  platformCaptions: Partial<Record<Platform, string>> | null,
  storyPlatforms: readonly Platform[],
): {
  platformLabels: string[];
  platformCaptions: Partial<Record<Platform, string>> | null;
  storyOnly: boolean;
  storyOnlyNote: string | null;
} {
  const storyOnlyNote = storyOnlyCaptionNote(targetPlatforms, storyPlatforms);
  return {
    platformLabels: targetPlatforms.map((platform) => storyPlatformLabel(platform, storyPlatforms)),
    platformCaptions: withStoryCaptions(platformCaptions, storyPlatforms as readonly StoryPlatform[]),
    storyOnly: storyOnlyNote !== null,
    storyOnlyNote,
  };
}

/**
 * The Queue edit dialog's two platform lists. `shown` leaves out Story
 * platforms (nothing to edit); `sent` is every platform, because what is sent
 * is cleaned against it and a shorter list would delete a Story platform's
 * stored caption (and withdraw a client's approval of it).
 */
export function queueEditorPlatforms(
  platforms: readonly Platform[],
  storyPlatforms: readonly Platform[],
): { shown: Platform[]; sent: Platform[] } {
  return { shown: platforms.filter((p) => !storyPlatforms.includes(p)), sent: [...platforms] };
}

/** " (Instagram as a Story)" for a post with no chosen platforms that carries a Story choice, else "". */
export function storyChoiceSuffix(storyPlatforms: readonly Platform[]): string {
  if (storyPlatforms.length === 0) return "";
  return ` (${storyPlatforms.map((p) => `${platformLabel(p)} as a Story`).join(", ")})`;
}
