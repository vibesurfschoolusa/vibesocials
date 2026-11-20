import type { Platform } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { captionCounter, MAX_CAPTION_CHARS } from "@/lib/captionLimits";
import { pinterestDescriptionLength } from "@/lib/pinterestApi";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { buildPlatformPreview, byteCountText } from "@/lib/platformPreview";
import { PLATFORM_ORDER } from "@/lib/platforms";
import { xWeightedLength } from "@/lib/xWeightedLength";
import { youtubeDescriptionLength } from "@/lib/youtubeDescription";

/**
 * A different caption per platform (`perPlatformOverrides`), as the composer
 * and the Queue's edit dialog hold it. Pure helpers only, shared by both and by
 * the editor component (components/composer/platform-caption-editor.tsx).
 */
export type PlatformOverrides = Partial<Record<Platform, string>>;

/** The smallest and largest `maxLength` POST /api/posts/enhance-caption accepts. */
export const ADAPT_MAX_LENGTH_MIN = 50;
export const ADAPT_MAX_LENGTH_MAX = 10_000;

/**
 * What to send: only captions for selected platforms that are not blank and
 * differ from the main caption, or `null` when none remain.
 *
 * At publish time an override is used as written, so a whitespace-only one
 * would post a blank caption; one equal to the main caption changes nothing,
 * and one for a platform not published to is never used. R48 review: nor is
 * one for a platform sent as a Story only (`storyOnly`), which publishes no
 * caption; sent, an over-long one would make the route refuse the post.
 */
export function cleanPlatformOverrides(
  overrides: PlatformOverrides | null | undefined,
  baseCaption: string,
  selectedPlatforms: readonly Platform[],
  storyOnly: readonly Platform[] = [],
): PlatformOverrides | null {
  if (!overrides) return null;
  const base = baseCaption.trim();
  const cleaned: PlatformOverrides = {};
  for (const platform of PLATFORM_ORDER) {
    const text = overrides[platform];
    if (typeof text !== "string" || !selectedPlatforms.includes(platform) || storyOnly.includes(platform)) continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed === base) continue;
    cleaned[platform] = text;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Switch one platform's own caption on (starting as a copy of the main caption,
 * unless it already has text) or off (removing it). Returns a new object.
 */
export function setPlatformOverride(
  overrides: PlatformOverrides | null | undefined,
  platform: Platform,
  on: boolean,
  baseCaption: string,
): PlatformOverrides {
  const next: PlatformOverrides = { ...overrides };
  if (on) {
    if (typeof next[platform] !== "string") next[platform] = baseCaption;
  } else {
    delete next[platform];
  }
  return next;
}

/** How many of `platforms` have their own caption switched on. */
export function countPlatformOverrides(
  overrides: PlatformOverrides | null | undefined,
  platforms: readonly Platform[],
): number {
  if (!overrides) return 0;
  return platforms.filter((platform) => typeof overrides[platform] === "string").length;
}

/** Same captions for the same platforms; `null` and `{}` both mean none. */
export function platformOverridesEqual(
  a: PlatformOverrides | null | undefined,
  b: PlatformOverrides | null | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Platform[]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

// The platform clients count in the unit the limits map names: extended
// grapheme clusters (lib/truncate.ts), X's weight (lib/xWeightedLength.ts) or,
// on Pinterest, code points (lib/pinterestApi.ts).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function platformLength(text: string, platform: Platform): number {
  const { unit } = PLATFORM_CAPTION_LIMITS[platform];
  if (unit === "xWeight") return xWeightedLength(text);
  if (unit === "codePoint") return pinterestDescriptionLength(text);
  return [...graphemeSegmenter.segment(text)].length;
}

/** Length of the footer the app appends to every caption (0 when there is none). */
function footerLength(footer: CaptionFooterUser | null | undefined, platform: Platform): number {
  return platformLength(buildCaptionWithFooter("", footer ?? {}), platform);
}

/** Room for the caption on this platform once the footer is added, or null when it has no limit. */
function captionRoom(platform: Platform, footer: CaptionFooterUser | null | undefined): number | null {
  const { charLimit, utf8ByteLimit } = PLATFORM_CAPTION_LIMITS[platform];
  if (charLimit === null && utf8ByteLimit !== undefined) {
    // YouTube always keeps its footer, tracked link included, inside the cut.
    return utf8ByteLimit - youtubeDescriptionLength(buildCaptionWithFooter("", footer ?? {}, platform));
  }
  return charLimit === null ? null : charLimit - footerLength(footer, platform);
}

export interface PlatformCaptionCounter {
  length: number;
  max: number;
  over: boolean;
  /** e.g. `120 / 254`. */
  label: string;
  /**
   * YouTube and Pinterest only, when a character counts as more than one: why
   * the number jumps. Shown on its own line under the count.
   */
  hint?: string;
}

/**
 * Counter for one platform's caption. On a platform with a limit it counts the
 * text that will be posted (buildPlatformPreview: footer parts that publishing
 * drops are left out, @-mentions too on X, X by its weight) against the limit,
 * and is over exactly when the preview says the post will be shortened. YouTube
 * is counted as it counts (UTF-8 bytes) against its 5,000 and Pinterest in code
 * points against its 800, each with a hint when a character counts as more
 * than one. Without a limit: the caption against the
 * app's 10,000-character cap, counted as the routes count it.
 */
export function platformCaptionCounter(
  text: string,
  platform: Platform,
  footer: CaptionFooterUser | null | undefined,
): PlatformCaptionCounter {
  const { charLimit, utf8ByteLimit } = PLATFORM_CAPTION_LIMITS[platform];
  const limit = charLimit ?? utf8ByteLimit ?? null;
  if (limit !== null) {
    const preview = buildPlatformPreview({ platform, caption: text, user: footer });
    // The count includes whatever part of the footer will be posted; say so,
    // or "hello" reading 50 looks wrong. No hint once the footer is dropped.
    const footerPosted =
      preview.rendered !== buildPlatformPreview({ platform, caption: text, user: null }).rendered;
    const incl = footerPosted ? " incl. footer" : "";
    // YouTube: the same count, limit and hint as its preview card.
    const bytes = byteCountText(preview);
    if (bytes !== null) {
      return {
        length: preview.byteCount ?? 0,
        max: preview.byteLimit ?? limit,
        over: preview.willTruncate,
        label: bytes,
        ...(preview.countHint ? { hint: preview.countHint } : {}),
      };
    }
    return {
      length: preview.charCount,
      max: limit,
      over: preview.willTruncate,
      label: `${preview.charCount.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}${incl}`,
      // Pinterest: why its code-point count runs ahead of the characters.
      ...(preview.countHint ? { hint: preview.countHint } : {}),
    };
  }
  // R51 publishing-flow L2: here only the routes' cap applies, so this counts
  // as findOverlongCaption does (UTF-16 units), and is red exactly when it refuses.
  const length = captionCounter(text).length;
  const max = MAX_CAPTION_CHARS;
  return {
    length,
    max,
    over: length > max,
    label: `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`,
  };
}

/**
 * The `maxLength` to send to "Adapt for {platform}": the platform's limit minus
 * the footer, kept inside what the route accepts; undefined for no limit.
 */
export function adaptMaxLength(
  platform: Platform,
  footer: CaptionFooterUser | null | undefined,
): number | undefined {
  const room = captionRoom(platform, footer);
  if (room === null) return undefined;
  return Math.min(ADAPT_MAX_LENGTH_MAX, Math.max(ADAPT_MAX_LENGTH_MIN, room));
}

/**
 * Put an "Adapt" answer into the platform's caption only while that caption
 * still reads exactly as it did at the press (R38 new-customer M1, the rule
 * useCaptionBox applies to the main caption). Typed meanwhile, switched off,
 * or reset by a save: the answer is dropped and the text stays.
 */
export function applyAdaptedCaption(
  prev: PlatformOverrides | null,
  platform: Platform,
  adapted: string,
  textAtPress: string,
): PlatformOverrides {
  if (prev?.[platform] !== textAtPress) return prev ?? {};
  return { ...prev, [platform]: adapted };
}

/**
 * What the Queue's edit dialog sends as `perPlatformOverrides`: undefined
 * (leave the field out), the cleaned captions, or `null` to remove them all.
 *
 * - A post with no caption of its own (`baseCaption` null) publishes the media
 *   item's captions, which the dialog shows. Saving gives it its own caption,
 *   and its own (null) overrides would replace those, so what is shown is
 *   always sent with it.
 * - Otherwise the captions go only when they differ from what was saved,
 *   compared as stored: cleaning both sides first would hide the removal of a
 *   caption that happens to equal the new main caption.
 */
export function queueOverridesToSend(input: {
  current: PlatformOverrides | null;
  saved: PlatformOverrides | null;
  mainCaption: string;
  platforms: readonly Platform[];
  hasOwnCaption: boolean;
}): PlatformOverrides | null | undefined {
  const { current, saved, mainCaption, platforms, hasOwnCaption } = input;
  if (hasOwnCaption && platformOverridesEqual(current, saved)) return undefined;
  return cleanPlatformOverrides(current, mainCaption, platforms);
}
