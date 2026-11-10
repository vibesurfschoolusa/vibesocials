import type { Platform } from "@prisma/client";

import { PLATFORM_ORDER } from "@/lib/platforms";

/**
 * 2026-11-01 scale audit (jobs, event size): the one cap on a caption's length, shared by
 * the API routes (POST /api/posts, PATCH /api/posts/[postJobId], POST
 * /api/media) and the three caption textareas (composer, Queue edit, media
 * library). A publish event carries the base caption plus up to 8 per-platform
 * overrides, and nothing capped their length, so an oversized caption could
 * exceed Inngest's event and step-output size limits.
 *
 * Counted as `string.length` (UTF-16 code units, so an emoji counts 2) - the unit
 * a browser textarea counts in, which keeps the composer and the API agreeing.
 * Above every platform's own caption limit except Facebook's (63,206).
 * Browser-safe: no server imports, so client components can use it.
 */
export const MAX_CAPTION_CHARS = 10_000;

/** `code` of the 400 an over-long caption gets. */
export const CAPTION_TOO_LONG_CODE = "CAPTION_TOO_LONG";

/**
 * The 400 `error` text, and the composer's inline message when called with
 * "Caption". `field` is `baseCaption` or `perPlatformOverrides.<platform>` on
 * the API, matching the field-named messages those routes already return.
 */
export function captionTooLongMessage(field: string): string {
  return `${field} is too long (max ${MAX_CAPTION_CHARS.toLocaleString("en-US")} characters).`;
}

/**
 * Keeps only the entries whose key is a `Platform`, dropping everything else.
 * Only platform keys are ever published (`overrides?.[platform]`), so an unknown
 * key is dead weight in the stored job and the publish event; dropping it is
 * what bounds the event at 1 base + 8 overrides x MAX_CAPTION_CHARS. (Rejecting
 * the key instead would block reusing a legacy media item that carries one.)
 */
export function pickPlatformOverrides(
  value: Record<string, string>,
): Partial<Record<Platform, string>> {
  const picked: Partial<Record<Platform, string>> = {};
  for (const platform of PLATFORM_ORDER) {
    // Own keys only, so `constructor` / `toString` can never read through the
    // prototype.
    if (Object.prototype.hasOwnProperty.call(value, platform)) {
      const text = value[platform];
      if (typeof text === "string") picked[platform] = text;
    }
  }
  return picked;
}

/**
 * The first field over the cap - `baseCaption`, then each override as
 * `perPlatformOverrides.<platform>` in platform order - or null when every
 * caption fits. Overrides are expected to be picked already
 * (`pickPlatformOverrides`), so only platform keys are looked at.
 */
export function findOverlongCaption(input: {
  baseCaption?: string | null;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}): string | null {
  if (typeof input.baseCaption === "string" && input.baseCaption.length > MAX_CAPTION_CHARS) {
    return "baseCaption";
  }
  const overrides = input.perPlatformOverrides;
  if (overrides) {
    for (const platform of PLATFORM_ORDER) {
      const text = overrides[platform];
      if (typeof text === "string" && text.length > MAX_CAPTION_CHARS) {
        return `perPlatformOverrides.${platform}`;
      }
    }
  }
  return null;
}

/** What a caption textarea's live counter shows. */
export interface CaptionCounter {
  length: number;
  max: number;
  over: boolean;
  /** e.g. `1,234 / 10,000`. */
  label: string;
}

/** Live counter state for a caption textarea; `over` is the submit guard. */
export function captionCounter(text: string): CaptionCounter {
  const length = text.length;
  return {
    length,
    max: MAX_CAPTION_CHARS,
    over: length > MAX_CAPTION_CHARS,
    label: `${length.toLocaleString("en-US")} / ${MAX_CAPTION_CHARS.toLocaleString("en-US")}`,
  };
}
