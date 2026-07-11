import type { Platform } from "@prisma/client";

import { buildCaptionWithFooter, type CaptionFooterUser } from "@/lib/captionFooter";
import { PLATFORM_CAPTION_LIMITS, TIKTOK_DEFAULT_CAPTION } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";

// A local grapheme counter, intentionally NOT added to lib/truncate.ts: Phase
// 7's only sanctioned non-UI change is the platformLimits.ts map + the
// xClient/tiktokClient refactors (see platformLimits.ts) — this preview
// helper is UI support, so it keeps its own tiny counting utility rather than
// touching truncate.ts's already-tested contract.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function countGraphemes(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

export interface PlatformPreviewInput {
  platform: Platform;
  /** The composer's base caption, before the user's footer is appended. */
  caption: string;
  /**
   * Per-platform caption override, if the user set one for this platform
   * (`perPlatformOverrides`). Mirrors the real posting path's truthiness
   * check EXACTLY — see `server/jobs/inngest-functions.ts`:
   * `captionOverride ? buildCaptionWithFooter(captionOverride, user) :
   * fullBaseCaption`. That means an empty string is "not set" and falls back
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
  /** Grapheme count of the full caption + footer text, BEFORE truncation. */
  charCount: number;
  /** This platform's client-enforced limit, or null when it doesn't truncate. */
  limit: number | null;
  /** True when `rendered` is shorter than the full (pre-truncation) text. */
  truncated: boolean;
  /**
   * True when `limit` is set and `charCount` exceeds it. Equal to `truncated`
   * by construction (`truncateGraphemes` only changes text that's over
   * budget) — exposed separately so callers can key off either field without
   * re-deriving one from the other.
   */
  willTruncate: boolean;
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
  let fullCaption = buildCaptionWithFooter(effectiveCaption, input.user ?? {});

  // Mirror the TikTok client's empty-caption fallback (computeTikTokCaption →
  // TIKTOK_DEFAULT_CAPTION) so the preview shows the default title TikTok will
  // actually post rather than an empty preview (Phase 7 review Minor #1). Narrow
  // case: reuse mode with a whitespace-only override + no footer settings yields
  // an empty footer-applied caption. Only TikTok substitutes a default; other
  // clients send empty as-is, so their preview correctly stays empty.
  if (input.platform === "tiktok" && !fullCaption) {
    fullCaption = TIKTOK_DEFAULT_CAPTION;
  }

  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS[input.platform];
  const charCount = countGraphemes(fullCaption);
  const rendered =
    charLimit === null ? fullCaption : truncateGraphemes(fullCaption, charLimit, { ellipsis });

  return {
    rendered,
    charCount,
    limit: charLimit,
    truncated: rendered !== fullCaption,
    willTruncate: charLimit !== null && charCount > charLimit,
  };
}
