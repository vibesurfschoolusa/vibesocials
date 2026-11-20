import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateUnits } from "@/lib/truncate";

/**
 * YouTube's video description rule, in one client-safe place (R52
 * platform-clients L1): youtubeClient.ts posts with it and the composer's
 * preview and counter (lib/platformPreview.ts, lib/platformOverrides.ts) cut
 * and count with it, so what is shown can't differ from what is sent.
 */

const { utf8ByteLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.youtube;

/** YouTube's limit on a video description, in UTF-8 bytes. */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = utf8ByteLimit as number;

/**
 * YouTube refuses "<" and ">" in a title or a description (fix round 1, M4), so
 * they become the single angle quotes, which read the same ("<3" -> "‹3").
 */
export function youtubeSafeText(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/** The description's length as YouTube counts it: UTF-8 bytes, after the angle quotes. */
export function youtubeDescriptionLength(caption: string): number {
  return utf8Length(youtubeSafeText(caption));
}

/**
 * The description: the caption with safe angle quotes, cut to YouTube's 5,000
 * bytes with "…" when it is longer, never inside a character or a link.
 */
export function fitYouTubeDescription(caption: string): string {
  return truncateUnits(
    youtubeSafeText(caption),
    YOUTUBE_DESCRIPTION_MAX_BYTES,
    (unit) => utf8Length(unit.text),
    ellipsis,
  );
}

/**
 * Why YouTube's count runs ahead of the letters a person sees, or `null` when
 * every character counts as one. A plain hint instead of the word "bytes".
 */
export function youtubeCountHint(text: string): string | null {
  const parts: string[] = [];
  if (/\P{ASCII}/u.test(text)) parts.push("most emoji as 4 and an accented letter as 2");
  if (/[<>]/.test(text)) parts.push("a < or > as 3");
  return parts.length > 0 ? `YouTube counts ${parts.join(", and ")}` : null;
}
