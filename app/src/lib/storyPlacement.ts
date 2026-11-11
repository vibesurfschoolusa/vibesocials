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
 * Why a Story cannot take a video this long, or null. Only the browser knows the
 * length; an unknown length (null) is allowed and the platform decides.
 */
export function storyVideoLengthRefusal(platform: StoryPlatform, durationSec: number | null): string | null {
  const limit = STORY_VIDEO_LIMIT_SEC[platform];
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= limit) return null;
  // Rounded up, so a video a fraction over the limit never reads as equal to it.
  return `${platformLabel(platform)} Stories take videos up to ${limit} seconds. This one is ${Math.ceil(durationSec)} seconds.`;
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
