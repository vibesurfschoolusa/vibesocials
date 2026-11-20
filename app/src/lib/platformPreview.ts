import type { Platform } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { fitPinterestDescription, pinterestCountHint, pinterestDescriptionLength } from "@/lib/pinterestApi";
import { type CaptionUnit, PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes, truncateKeepingLinks } from "@/lib/truncate";
import { removeXMentions } from "@/lib/xMentions";
import { truncateXWeighted, xWeightedLength } from "@/lib/xWeightedLength";
import { fitYouTubeDescription, youtubeCountHint, youtubeDescriptionLength } from "@/lib/youtubeDescription";

// A local grapheme counter, intentionally NOT added to lib/truncate.ts: Phase
// 7's only sanctioned non-UI change is the platformLimits.ts map + the
// xClient/tiktokClient refactors (see platformLimits.ts) — this preview
// helper is UI support, so it keeps its own tiny counting utility rather than
// touching truncate.ts's already-tested contract.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function countGraphemes(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

/** The text's length in the unit its platform's client cuts by (platformLimits.ts). */
function countIn(unit: CaptionUnit | null, text: string): number {
  if (unit === "xWeight") return xWeightedLength(text);
  if (unit === "codePoint") return pinterestDescriptionLength(text);
  return countGraphemes(text);
}

export interface PlatformPreviewInput {
  platform: Platform;
  /** The composer's base caption, before the user's footer is appended. */
  caption: string;
  /**
   * Per-platform caption override, if the user set one for this platform
   * (`perPlatformOverrides`). Mirrors the real posting path's truthiness
   * check EXACTLY — see `server/jobs/inngest-functions.ts`:
   * the override when it is truthy, else the base caption, then
   * `buildCaptionWithFooter(..., workspace, platform)`. That means an empty string is "not set" and falls back
   * to `caption`, but a whitespace-only override IS honored verbatim (odd,
   * but that is what actually gets posted, so the preview must match it).
   */
  override?: string | null;
  /**
   * Footer settings for the posting user. Optional so the preview still
   * renders (minus the footer) when footer data isn't available client-side
   * — see create-post-form.tsx.
   */
  user?: CaptionFooterUser | null;
}

export interface PlatformPreviewResult {
  /**
   * The exact text that will be POSTED to this platform: caption + footer,
   * override applied, and — for a platform whose client truncates (see
   * platformLimits.ts) — cut with `truncateGraphemes` the SAME way that
   * client does. This is the preview-vs-reality contract: render this
   * string, not a re-derived approximation.
   */
  rendered: string;
  /**
   * Length of the full caption + footer text, BEFORE truncation, in the
   * platform's unit (platformLimits.ts): X's weight on X
   * (lib/xWeightedLength.ts), code points on Pinterest, graphemes elsewhere.
   */
  charCount: number;
  /**
   * This platform's client-enforced limit in `charCount`'s unit, or null when
   * it has none. YouTube has none in characters: see `byteLimit`.
   */
  limit: number | null;
  /**
   * Only for a platform cut by UTF-8 bytes (YouTube's description): the full
   * text's size as that client counts it, and its limit. Absent elsewhere.
   */
  byteCount?: number;
  byteLimit?: number;
  /**
   * Why the count runs ahead of the characters a person sees, when one counts
   * as more than one: YouTube (bytes) and Pinterest (code points) only.
   */
  countHint?: string;
  /**
   * Only on a platform whose card shows its counter's label (YouTube,
   * Pinterest; see `unitCountText`): true when the count includes the
   * workspace's footer. YouTube always keeps its footer (captionFooter.ts drops
   * none without a character limit), so this holds over the limit too, where
   * the cut takes the footer; Pinterest's is false once the footer is dropped.
   */
  countIncludesFooter?: boolean;
  /** True when `rendered` is shorter than the full (pre-truncation) text. */
  truncated: boolean;
  /**
   * True when `limit` is set and `charCount` exceeds it (on YouTube, when
   * `byteCount` exceeds `byteLimit`). Equal to `truncated`
   * by construction (`truncateGraphemes` only changes text that's over
   * budget) — exposed separately so callers can key off either field without
   * re-deriving one from the other.
   */
  willTruncate: boolean;
}

/**
 * "4,812 / 5,000 incl. footer" for a platform whose count is not the
 * characters a person sees: YouTube in bytes, Pinterest in code points (R53).
 * Null elsewhere, where the card keeps its own line. The caption counter and
 * the preview card both show this, with `countHint` beneath, so they can't differ.
 */
export function unitCountText(preview: PlatformPreviewResult): string | null {
  if (preview.countIncludesFooter === undefined) return null;
  const count = preview.byteCount ?? preview.charCount;
  const limit = preview.byteLimit ?? preview.limit;
  if (limit === null) return null;
  return `${count.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}${
    preview.countIncludesFooter ? " incl. footer" : ""
  }`;
}

/**
 * Pure computation behind the composer's per-platform live preview (Roadmap
 * Phase 7, spec §7.1). Mirrors EXACTLY what `server/jobs/inngest-functions.ts`
 * does before handing `caption` to a `PlatformClient.publishVideo`:
 * override-or-base -> `buildCaptionWithFooter` -> (platform-specific,
 * possible) `truncateGraphemes` via the shared `platformLimits.ts` map.
 *
 * Zero React/DOM dependency, so it is unit-testable without a browser or
 * mocked network calls — see platformPreview.test.ts. The composer's preview
 * component should render `result.rendered` verbatim rather than
 * re-implementing any of this.
 */
export function buildPlatformPreview(input: PlatformPreviewInput): PlatformPreviewResult {
  const effectiveCaption = input.override ? input.override : input.caption;
  // The platform is passed, as the publish function does, so the footer carries
  // this platform's tracking tags when the workspace has them on.
  let fullCaption = buildCaptionWithFooter(effectiveCaption, input.user ?? {}, input.platform);
  // With nothing typed the footer would follow an empty first line and a blank
  // line. POST /api/posts refuses an empty caption, so no such text is ever
  // sent: the preview shows the footer alone (go-live check 2026-11-11).
  if (!effectiveCaption.trim()) {
    fullCaption = fullCaption.replace(/^\n\n/, "");
  }

  // TikTok gets no substitute title for an empty caption (computeTikTokCaption):
  // the preview stays empty, as for every other platform.

  // Mirror the X client (computeTweetText): X refuses API posts that
  // @-mention users, so the X text goes out without them (lib/xMentions.ts).
  if (input.platform === "x") {
    fullCaption = removeXMentions(fullCaption);
  }

  const { charLimit, unit, utf8ByteLimit, ellipsis } = PLATFORM_CAPTION_LIMITS[input.platform];
  if (unit === "utf8Byte" && utf8ByteLimit !== undefined) {
    // R52 platform-clients L1: the description as youtubeClient.ts sends it,
    // angle quotes swapped and cut by bytes, with the client's own function.
    const rendered = fitYouTubeDescription(fullCaption);
    const byteCount = youtubeDescriptionLength(fullCaption);
    const willTruncate = byteCount > utf8ByteLimit;
    const countHint = youtubeCountHint(fullCaption);
    return {
      rendered,
      charCount: countGraphemes(fullCaption),
      limit: null,
      byteCount,
      byteLimit: utf8ByteLimit,
      ...(countHint ? { countHint } : {}),
      countIncludesFooter: buildCaptionWithFooter("", input.user ?? {}, input.platform) !== "",
      truncated: willTruncate,
      willTruncate,
    };
  }
  // Counted in the unit the map names and cut with the client's own function:
  // X by its weight, as computeTweetText does (fix round 1, M5); LinkedIn keeps
  // a link whole at the cut, as computeLinkedInCommentary does; Pinterest by
  // code points with fitPinterestDescription (R53 platform-clients L1); every
  // other platform by graphemes.
  const charCount = countIn(unit, fullCaption);
  let rendered = fullCaption;
  if (charLimit !== null) {
    if (input.platform === "x") rendered = truncateXWeighted(fullCaption, charLimit, ellipsis);
    else if (input.platform === "linkedin") rendered = truncateKeepingLinks(fullCaption, charLimit, ellipsis);
    else if (input.platform === "pinterest") rendered = fitPinterestDescription(fullCaption);
    else rendered = truncateGraphemes(fullCaption, charLimit, { ellipsis });
  }
  const countHint = input.platform === "pinterest" ? pinterestCountHint(fullCaption) : null;
  // Pinterest's card shows its counter's label (unitCountText): the footer is
  // counted when publishing keeps it, as the counter decides.
  const pinterest =
    input.platform === "pinterest"
      ? {
          countIncludesFooter:
            buildCaptionWithFooter(effectiveCaption, input.user ?? {}, input.platform) !==
            buildCaptionWithFooter(effectiveCaption, {}, input.platform),
        }
      : {};

  return {
    rendered,
    charCount,
    limit: charLimit,
    ...(countHint ? { countHint } : {}),
    ...pinterest,
    truncated: rendered !== fullCaption,
    willTruncate: charLimit !== null && charCount > charLimit,
  };
}
