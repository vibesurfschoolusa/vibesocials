import type { Platform } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { MAX_CAPTION_CHARS } from "@/lib/captionLimits";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { PLATFORM_ORDER } from "@/lib/platforms";

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
 * and one for a platform not published to is never used.
 */
export function cleanPlatformOverrides(
  overrides: PlatformOverrides | null | undefined,
  baseCaption: string,
  selectedPlatforms: readonly Platform[],
): PlatformOverrides | null {
  if (!overrides) return null;
  const base = baseCaption.trim();
  const cleaned: PlatformOverrides = {};
  for (const platform of PLATFORM_ORDER) {
    const text = overrides[platform];
    if (typeof text !== "string" || !selectedPlatforms.includes(platform)) continue;
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

// The platform clients count extended grapheme clusters (lib/truncate.ts).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function countGraphemes(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

/** Length of the footer the app appends to every caption (0 when there is none). */
function footerLength(footer: CaptionFooterUser | null | undefined): number {
  return countGraphemes(buildCaptionWithFooter("", footer ?? {}));
}

/** Room for the caption on this platform once the footer is added, or null when it has no limit. */
function captionRoom(platform: Platform, footer: CaptionFooterUser | null | undefined): number | null {
  const { charLimit } = PLATFORM_CAPTION_LIMITS[platform];
  return charLimit === null ? null : charLimit - footerLength(footer);
}

export interface PlatformCaptionCounter {
  length: number;
  max: number;
  over: boolean;
  /** e.g. `120 / 254`. */
  label: string;
}

/**
 * Counter for one platform's caption: against that platform's limit minus the
 * footer, or the app's 10,000-character cap when the platform has no limit.
 */
export function platformCaptionCounter(
  text: string,
  platform: Platform,
  footer: CaptionFooterUser | null | undefined,
): PlatformCaptionCounter {
  const length = countGraphemes(text);
  const max = captionRoom(platform, footer) ?? MAX_CAPTION_CHARS;
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
