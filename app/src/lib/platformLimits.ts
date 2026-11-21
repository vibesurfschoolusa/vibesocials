import type { Platform } from "@prisma/client";

import { MULTI_PHOTO_MIME_TYPES, X_MAX_PHOTOS } from "./postMedia";

/**
 * Roadmap Phase 7 (spec §7.1) — single source of truth for each platform's
 * CLIENT-ENFORCED caption length limit.
 *
 * `charLimit: number` means the corresponding client in `server/platforms/`
 * truncates the caption to that many of the entry's `unit` (mostly extended
 * grapheme clusters), at a whole word, with an AtWord function of
 * `lib/truncate.ts` (R64 platform-clients L1; wordSafeCut.guard.test.ts
 * refuses a plain cut), before posting. `charLimit: null`
 * means that client does NOT truncate today — whatever caption is built is
 * sent as-is (the platform's own API may enforce its own limit server-side,
 * but nothing in this codebase does it client-side).
 *
 * This map exists so the composer's live preview (`lib/platformPreview.ts`)
 * can never drift from what actually gets posted: the preview and the real
 * `xClient`/`tiktokClient` truncation both read the SAME numbers from here.
 *
 * IMPORTANT: raising a `null` to a real number here does NOT, by itself,
 * change what gets posted — it would only change what the preview *predicts*,
 * making the preview show a truncation that never actually happens. Adding
 * real truncation for a platform that doesn't have it today is a deliberate,
 * separate posting-behavior change: it requires adding a `truncateGraphemesAtWord`
 * call to that platform's client (see xClient.ts / tiktokClient.ts for the
 * pattern) in the SAME change that edits this map — never edit this map alone.
 */
/**
 * The unit a platform's client counts its caption in before it cuts (R53
 * platform-clients L1), so the preview and counter count in it too:
 * - `grapheme`: extended grapheme clusters, what a person sees as one character;
 * - `xWeight`: X's weight (lib/xWeightedLength.ts), an emoji 2 and a link 23;
 * - `codePoint`: Unicode code points, what a JSON `maxLength` counts (Pinterest);
 *   a heart or a flag is one character and 2 code points;
 * - `utf8Byte`: UTF-8 bytes after the angle quotes (YouTube's description);
 * - `utf16`: UTF-16 code units, JavaScript's `string.length` (TikTok's title),
 *   an emoji 2.
 */
export type CaptionUnit = "grapheme" | "xWeight" | "codePoint" | "utf8Byte" | "utf16";

export interface PlatformCaptionLimit {
  /**
   * Max caption length in `unit` (grapheme, X weight or code points), or
   * `null` when the client sends the caption untruncated or, like YouTube,
   * cuts it by bytes (`utf8ByteLimit`).
   */
  charLimit: number | null;
  /** What `charLimit` (or `utf8ByteLimit`) counts; null when nothing is cut. */
  unit: CaptionUnit | null;
  /**
   * A limit in UTF-8 bytes instead, for a client that cuts by bytes (YouTube's
   * description, lib/youtubeDescription.ts). Set only with `charLimit: null`,
   * so the grapheme readers (the footer rule in captionFooter.ts among them)
   * treat that platform exactly as before.
   */
  utf8ByteLimit?: number;
  /** Ellipsis appended on truncation. Only meaningful when a limit is set. */
  ellipsis?: string;
}

export const PLATFORM_CAPTION_LIMITS: Record<Platform, PlatformCaptionLimit> = {
  // X counts by weight, not graphemes (fix round 1, M5): an emoji 2, a link 23
  // (lib/xWeightedLength.ts). xClient.ts cuts with truncateXWeighted.
  x: { charLimit: 280, unit: "xWeight", ellipsis: "..." },
  // Matches the truncateUtf16AtWord call in server/platforms/tiktokClient.ts.
  // R65: TikTok's Direct Post reference: "maximum length is 2200 in UTF-16 runes".
  tiktok: { charLimit: 2200, unit: "utf16" },
  // youtubeClient.ts fits the VIDEO TITLE (a separate field, 100 chars) and
  // cuts the description, footer included, to YouTube's 5,000 BYTES with
  // fitYouTubeDescription (lib/youtubeDescription.ts), which reads this entry.
  youtube: { charLimit: null, unit: "utf8Byte", utf8ByteLimit: 5000, ellipsis: "…" },
  // Matches the truncateGraphemesAtWord call in server/platforms/instagramClient.ts
  // (computeInstagramCaption). Instagram rejects a caption over 2,200
  // characters, so before the 2026-11-01 audit an over-long caption failed the
  // whole publish; the composer preview now warns and the client truncates.
  instagram: { charLimit: 2200, unit: "grapheme" },
  // Matches the truncateKeepingLinksAtWord call in server/platforms/linkedinClient.ts
  // (computeLinkedInCommentary): LinkedIn refuses commentary over 3,000
  // characters (fix round 1, M6). The footer goes first (lib/captionFooter.ts).
  linkedin: { charLimit: 3000, unit: "grapheme", ellipsis: "..." },
  // No client-side truncation today (server/platforms/facebookPageClient.ts).
  facebook_page: { charLimit: null, unit: null },
  // Matches computeGbpPostSummary in server/platforms/googleBusinessProfileClient.ts.
  // A photo is published as a Business Profile post ("Update"), whose text
  // Google caps at 1,500 characters.
  google_business_profile: { charLimit: 1500, unit: "grapheme", ellipsis: "..." },
  // Matches fitPinterestDescription (lib/pinterestApi.ts), which
  // server/platforms/pinterestClient.ts sends as the Pin's description:
  // Pinterest's limit is 800 characters as a JSON maxLength counts them, code
  // points, and it refuses a longer one.
  pinterest: { charLimit: 800, unit: "codePoint", ellipsis: "..." },
};


/**
 * Platforms whose client publishes a post that is only text (2026-11-10): each
 * implements `publishText` (server/platforms/types.ts). Instagram, TikTok,
 * YouTube and Pinterest need a file. The posts route and the composer both read
 * this list, so neither can offer what the publish path cannot do.
 */
export const TEXT_ONLY_PLATFORMS: readonly Platform[] = [
  "facebook_page",
  "x",
  "linkedin",
  "google_business_profile",
];

/**
 * Release switch for posts without a photo (fix round 1). Released in two steps:
 * first every reader learns to cope with a post that has no file while nobody
 * can create one (false), then a one-line release turns creating them on. So a
 * rollback by one deployment never meets a text post the older code cannot read.
 * Tests override the function, not this constant.
 */
const TEXT_POSTS_ENABLED = true;

/** Can a person create a post without a photo (POST /api/posts `textOnly`, the Create page)? */
export function textPostsEnabled(): boolean {
  return TEXT_POSTS_ENABLED;
}

/** Can `platform` publish a post that has no file? */
export function platformAcceptsTextOnly(platform: Platform): boolean {
  return TEXT_ONLY_PLATFORMS.includes(platform);
}

/** The two kinds of media a post can carry. */
export type MediaKind = "image" | "video";

/**
 * Media kinds each platform's CLIENT accepts — read from the client code, not
 * from platform documentation, so this can't claim support the publish path
 * doesn't have (2026-11-01 audit). Each entry cites where the client decides:
 *
 * - youtube        — video only: rejects a non-video with YOUTUBE_MEDIA_NOT_VIDEO
 *                    (server/platforms/youtubeClient.ts:65-75).
 * - tiktok         — video only: TIKTOK_MEDIA_NOT_VIDEO
 *                    (server/platforms/tiktokClient.ts:654-658).
 * - facebook_page  — both (since 2026-11-08): an image goes to /{page}/photos,
 *                    a video to /{page}/videos; anything else is
 *                    FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE
 *                    (server/platforms/facebookPageClient.ts, `mediaKindOf`).
 * - instagram      — both: a video becomes a REELS container, anything else an
 *                    IMAGE container (server/platforms/instagramClient.ts:126,
 *                    156-161).
 * - x              — both: rejects only what is neither (X_INVALID_MEDIA_TYPE,
 *                    server/platforms/xClient.ts:528-537).
 * - linkedin       — both: uploads a video via uploadVideo, an image via
 *                    uploadImage (server/platforms/linkedinClient.ts:619-643).
 * - google_business_profile — both: a photo becomes a post (localPosts), a
 *                    video is added to the gallery (media, "VIDEO")
 *                    (server/platforms/googleBusinessProfileClient.ts, `isPhoto`);
 *                    the formats Google's docs refuse are in PLATFORM_REFUSED_FORMATS.
 * - pinterest      — both: a photo becomes a Pin by URL, a video is uploaded and
 *                    processed first; anything else is
 *                    PINTEREST_UNSUPPORTED_MEDIA_TYPE
 *                    (server/platforms/pinterestClient.ts, `mediaKindOf`).
 */
export const PLATFORM_ACCEPTED_MEDIA: Record<Platform, readonly MediaKind[]> = {
  youtube: ["video"],
  tiktok: ["video"],
  facebook_page: ["image", "video"],
  instagram: ["image", "video"],
  x: ["image", "video"],
  linkedin: ["image", "video"],
  google_business_profile: ["image", "video"],
  pinterest: ["image", "video"],
};

/**
 * Formats a platform refuses although it takes that kind of media, from the
 * platform's own docs, with the short reason the composer shows.
 *
 * - linkedin — the Images API takes "JPG, GIF, and PNG formats" and the Videos
 *   API "File format: MP4" (checked 2026-11-09). WebP and WebM are refused here;
 *   MOV, the iPhone's format, stays allowed: if LinkedIn cannot process one, the
 *   publish fails with LINKEDIN_VIDEO_PROCESSING_FAILED instead of a broken post.
 */
const PLATFORM_REFUSED_FORMATS: Partial<Record<Platform, Readonly<Record<string, string>>>> = {
  linkedin: { "image/webp": "JPG, PNG or GIF only", "video/webm": "MP4 or MOV only" },
  // Pinterest's video Pins take .mp4, .mov and .m4v (H.264 / H.265); a WebM
  // upload fails its processing, so it is refused up front.
  pinterest: { "video/webm": "MP4 or MOV only" },
  // Facebook's Page photos reference (checked 2026-11-15) lists ".jpeg, .bmp,
  // .png, .gif, .tiff"; WebP is not among them.
  facebook_page: { "image/webp": "JPG, PNG or GIF only" },
  // Instagram's content-publishing docs (checked 2026-11-15): Reels and video
  // Stories take "Container: MOV or MP4". A WebM failed Instagram's processing
  // after the post was sent; now it is refused before.
  instagram: { "video/webm": "MP4 or MOV only" },
  // Google's photo guidelines (support.google.com/business/answer/6103862,
  // checked 2026-11-15): "Format: JPG or PNG". A scheduled post made before
  // this rule still runs and fails with the client's plain refusal text.
  google_business_profile: { "image/webp": "JPG or PNG only", "image/gif": "JPG or PNG only" },
};

/**
 * Classify a MIME type the way every client does — a plain, case-sensitive
 * `startsWith` on `video/` / `image/` — or `null` for anything else.
 */
export function mediaKindOf(mimeType: string): MediaKind | null {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

/**
 * Can `platform` publish media of this MIME type?
 *
 * `null` / `undefined` means "no media chosen yet" and accepts everything (there
 * is nothing to be incompatible with); any actual MIME type that is neither an
 * image nor a video — including the empty string a browser reports for an
 * unknown file — is accepted by no platform.
 */
export function platformAcceptsMedia(
  platform: Platform,
  mimeType: string | null | undefined,
): boolean {
  if (mimeType == null) return true;
  const kind = mediaKindOf(mimeType);
  return (
    kind !== null &&
    PLATFORM_ACCEPTED_MEDIA[platform].includes(kind) &&
    PLATFORM_REFUSED_FORMATS[platform]?.[mimeType] === undefined
  );
}

/**
 * Short, user-facing reason `platform` can't publish this media (shown next to
 * a disabled platform in the composer), or `null` when it can.
 */
export function unsupportedMediaReason(
  platform: Platform,
  mimeType: string | null | undefined,
): string | null {
  if (platformAcceptsMedia(platform, mimeType)) return null;
  if (mimeType == null || mediaKindOf(mimeType) === null) return "Unsupported file type";
  const refusedFormat = PLATFORM_REFUSED_FORMATS[platform]?.[mimeType];
  if (refusedFormat !== undefined) return refusedFormat;
  return PLATFORM_ACCEPTED_MEDIA[platform].includes("video") ? "Video only" : "Images only";
}

/**
 * How many of a post's files `platform` receives, read from each client
 * (R21 platform-clients M1): LinkedIn, Facebook Page and Instagram post every
 * file (multi-image post, attached_media, carousel); X the first
 * {@link X_MAX_PHOTOS} (xClient.ts publishPhotos); every other client reads
 * only `ctx.mediaItem`, the first.
 */
export function filesSentTo(platform: Platform, fileCount: number): number {
  switch (platform) {
    case "linkedin":
    case "facebook_page":
    case "instagram":
      return fileCount;
    case "x":
      return Math.min(fileCount, X_MAX_PHOTOS);
    default:
      return Math.min(fileCount, 1);
  }
}

/** A post's file types in order: one type, a list, or nothing chosen yet. */
export type MediaTypes = string | readonly string[] | null | undefined;

/** The list form of {@link MediaTypes}; `null` when no file is chosen yet. */
export function mediaTypeList(types: MediaTypes): readonly string[] | null {
  if (types == null) return null;
  if (typeof types === "string") return [types];
  return types.length > 0 ? types : null;
}

/** "WebP", "JPG", "WebM" for a reason that names the file's format. */
function formatName(mimeType: string): string {
  const names: Record<string, string> = {
    "image/jpeg": "JPG",
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "video/mp4": "MP4",
    "video/quicktime": "MOV",
    "video/webm": "WebM",
  };
  return names[mimeType] ?? (mimeType.split("/")[1] ?? mimeType).toUpperCase();
}

/**
 * The formats a several-photo post can hold on `platform`: the set's types
 * (no GIF, MULTI_PHOTO_MIME_TYPES) that the platform takes. "JPG or PNG only"
 * for Facebook and LinkedIn, so the reason never offers a GIF the picker refuses.
 */
export function photoSetFormatsReason(platform: Platform): string {
  const names = MULTI_PHOTO_MIME_TYPES.filter((type) => platformAcceptsMedia(platform, type)).map(formatName);
  const last = names.pop();
  return `${names.length > 0 ? `${names.join(", ")} or ` : ""}${last} only`;
}

/**
 * Why `platform` can't publish this post's files, judged on every file it
 * receives ({@link filesSentTo}), or `null` when it can. One file: the same
 * answer as {@link unsupportedMediaReason}. Several: a refused format names
 * the file and the formats a several-photo post can hold there ("photo 2 is
 * WebP; JPG or PNG only"), so the order of the photos never changes the answer.
 */
export function platformFilesReason(platform: Platform, types: MediaTypes): string | null {
  const list = mediaTypeList(types);
  if (list === null) return null;
  if (list.length === 1) return unsupportedMediaReason(platform, list[0]);
  const received = list.slice(0, filesSentTo(platform, list.length));
  for (const [index, mimeType] of received.entries()) {
    const reason = unsupportedMediaReason(platform, mimeType);
    if (reason === null) continue;
    if (PLATFORM_REFUSED_FORMATS[platform]?.[mimeType] === undefined) return reason;
    if (mediaKindOf(mimeType) === "image") {
      return `photo ${index + 1} is ${formatName(mimeType)}; ${photoSetFormatsReason(platform)}`;
    }
    return `file ${index + 1} is ${formatName(mimeType)}; ${reason}`;
  }
  return null;
}

/** Can `platform` publish every file of this post it receives? */
export function platformAcceptsFiles(platform: Platform, types: MediaTypes): boolean {
  return platformFilesReason(platform, types) === null;
}
