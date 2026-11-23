import type { Platform } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountInitials, accountLabel, firstName, nameInitial } from "@/lib/accountInitials";
import { cleanAltText, fitAltText } from "@/lib/altText";
import { cleanBrandVoice, cleanBrandVoiceExamples, exampleBoxStatus, mergeExampleCaptions } from "@/lib/brandVoice";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import { captionCounter } from "@/lib/captionLimits";
import { cleanAvoidCaptions, cleanRecentCaptions } from "@/lib/captionVariety";
import { workspaceInitials } from "@/lib/clientPage";
import { hashtagsIn, withoutHashtagSigns } from "@/lib/hashtags";
import { toLinkedInLittleText } from "@/lib/linkedinApi";
import { reportCaption } from "@/lib/monthlyReport";
import { fitPinterestDescription, fitPinterestTitle, pinterestCountHint, pinterestDescriptionLength } from "@/lib/pinterestApi";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { platformCaptionCounter } from "@/lib/platformOverrides";
import { buildPlatformPreview } from "@/lib/platformPreview";
import { labelName } from "@/lib/queueLabelName";
import { replyBytes, replyCounter, replyTooLong } from "@/lib/reviewReplyLength";
import { redactLinkTokens } from "@/lib/sentryRedaction";
import { trackedWebsiteLink } from "@/lib/trackingTags";
import {
  fitTitle,
  graphemeCount,
  textUnits,
  trimLinkTrailing,
  truncateGraphemes,
  truncateGraphemesAtWord,
  truncateGraphemesWithinCodePoints,
  truncateKeepingLinks,
  truncateKeepingLinksAtWord,
  truncateUtf16AtWord,
} from "@/lib/truncate";
import { cleanSenderText } from "@/lib/uploadLink";
import { removeXMentions } from "@/lib/xMentions";
import { truncateXWeighted, xWeightedLength } from "@/lib/xWeightedLength";
import { fitYouTubeDescription, youtubeCountHint, youtubeDescriptionLength, youtubeSafeText } from "@/lib/youtubeDescription";
import { computeGbpPostSummary } from "@/server/platforms/googleBusinessProfileClient";
import { computeInstagramCaption, fitInstagramTags } from "@/server/platforms/instagramClient";
import { computeLinkedInCommentary } from "@/server/platforms/linkedinClient";
import { computeTikTokCaption } from "@/server/platforms/tiktokClient";
import { computeTweetText } from "@/server/platforms/xClient";
import { fitYouTubeTitle } from "@/server/platforms/youtubeClient";

/**
 * R68 (the cure, pages-a-3 L1, publishing-flow L1): text helpers that cost the
 * square of their input kept turning up one at a time: firstName's pattern
 * (R66), fitAltText (R68) and removeXMentions (R68), each costing seconds of
 * server CPU, or a frozen Create page, on one pasted caption. This times every
 * exported helper that walks user text on adversarial inputs, so a new
 * super-linear one fails here.
 *
 * Two checks on each input:
 * - Growth, which holds on any machine: the helper runs at 8,000 and at
 *   16,000 characters, and doubling the input may at most triple the time. A
 *   linear helper about doubles (at most 2.84x measured); a quadratic one
 *   about quadruples (main's removeXMentions: 4.0x).
 *   - A pause (the collector, a busy runner) only lengthens a call. The small
 *     size is always timed three times and its fastest call counts, so a pause
 *     there is unlikely to hide growth; the large one is timed up to seven times,
 *     until it is not over 3x, so pauses there are unlikely to fake it.
 *   - A first ratio over 3 is checked again at 16,000 and 32,000, and only
 *     both failing fails: a linear helper can step up once (a cache, a string
 *     turning flat), but a quadratic one grows at every size.
 *   - A helper under 1 ms at 16,000 is too quick for a ratio, so it is timed
 *     again at 32,000 and 64,000, where a quadratic one is 16x slower. One
 *     under 1/16 ms at 16,000 could not reach 1 ms there even if quadratic,
 *     and is harmless at any caption's size.
 * - A backstop budget at 16,000 characters, at least 10x the slowest linear
 *   call measured (MEASURED_MS).
 *
 * The composed helpers (buildCaptionWithFooter, buildPlatformPreview,
 * platformCaptionCounter) run the single ones, which are timed on every
 * input, so they are timed once per platform, on the run that platform's own
 * code walks (commas for X's mentions, dotted labels for LinkedIn's links, and
 * so on).
 *
 * Left out, each for a reason:
 * - jpegFileName (prepareUploadFile.ts): its /[. ]+$/ is quadratic, but its
 *   input is a file name, at most 255 characters on every file system.
 * - captionVarietyBlock, brandVoicePrompt, workspaceBrandVoicePrompt: they
 *   only join text the clean functions timed here already capped.
 * - isUploadLinkTokenShape and the other shape tests: an anchored pattern
 *   with no nested repeat, so linear by construction.
 */

const SIZE = 16_000;
/** The growth is measured from SIZE / SPAN to SIZE. */
const SPAN = 2;
/** Doubling the input may at most triple the time. */
const MAX_GROWTH = 3;
/** Below this, at the larger size, a call is too quick for its growth to mean anything. */
const GROWTH_FLOOR_MS = 1;
/** The small size is always timed this many times, and the fastest call counts. */
const TIMINGS = 3;
/**
 * The large size is timed up to this many times while it looks too slow: on a
 * busy runner the system can stop any one call for a time slice (about 15 ms
 * on Windows), which would fake growth in a call of a few ms.
 */
const LARGE_TIMINGS = 7;
// The slowest linear calls measured at 16,000 characters (2026-11-22, this
// machine): a single helper, and a composed one on its platform's run.
const MEASURED_MS = { single: 22, composed: 42 };
const BUDGET_MS = 250;
const COMPOSED_BUDGET_MS = 450;

/** The runs a pattern or a walk may restart on, each one character or grapheme repeated. */
const RUNS = {
  commas: ",",
  semicolons: ";",
  "commas and semicolons": ",;",
  spaces: " ",
  dots: ".",
  "dotted labels": "a.",
  hyphens: "-",
  "at signs": "@",
  mentions: "@a",
  "hash signs": "#",
  hashtags: "#a",
  "combining marks": "\u0301",
  emoji: "\u{1F30A}",
  "ZWJ chain": "\u{1F468}\u200D",
  "line breaks": "\n",
} as const;
type RunName = keyof typeof RUNS;

/** `unit` repeated to fill about `room` characters. */
function runOf(name: RunName, room: number): string {
  const unit = RUNS[name];
  return unit.repeat(Math.max(1, Math.floor(room / unit.length)));
}

/** One run between tags, filled to `size` characters. */
function betweenTags(name: RunName, size = SIZE): string {
  return `#a ${runOf(name, size - 11)} @kai #b`;
}

/** Each run mid-token, after a mention, and between tags, filled to `size` characters. */
function adversarialInputs(size = SIZE): Array<[string, string]> {
  return (Object.keys(RUNS) as RunName[]).flatMap((name): Array<[string, string]> => [
    [`${name} mid-token`, `#a${runOf(name, size - 3)}b`],
    [`${name} after a mention`, `@kai ${runOf(name, size - 6)}x`],
    [`${name} between tags`, betweenTags(name, size)],
  ]);
}

const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves @kai", trackWebsiteLinks: true };

/** The run each platform's own code walks: X's mentions, LinkedIn's links, YouTube's bytes, and so on. */
const PLATFORM_RUN: Record<Platform, RunName> = {
  x: "commas",
  linkedin: "dotted labels",
  youtube: "combining marks",
  pinterest: "emoji",
  tiktok: "ZWJ chain",
  instagram: "hashtags",
  google_business_profile: "spaces",
  facebook_page: "mentions",
};
const platforms = Object.keys(PLATFORM_CAPTION_LIMITS) as Platform[];

type Helper = (text: string) => unknown;

const HELPERS: Array<[string, Helper]> = [
  ["graphemeCount", graphemeCount],
  ["truncateGraphemes", (text) => truncateGraphemes(text, 2_200, { ellipsis: "…" })],
  ["truncateGraphemesWithinCodePoints", (text) => truncateGraphemesWithinCodePoints(text, 200)],
  ["truncateGraphemesAtWord", (text) => truncateGraphemesAtWord(text, 2_200, { ellipsis: "..." })],
  ["truncateUtf16AtWord", (text) => truncateUtf16AtWord(text, 2_200, { ellipsis: "..." })],
  ["fitTitle", (text) => fitTitle(text, 100)],
  ["textUnits", textUnits],
  ["textUnits, whole graphemes", (text) => textUnits(text, { wholeGraphemes: true })],
  ["trimLinkTrailing", trimLinkTrailing],
  ["truncateKeepingLinks", (text) => truncateKeepingLinks(text, 3_000, "...")],
  ["truncateKeepingLinksAtWord", (text) => truncateKeepingLinksAtWord(text, 3_000, "...")],
  ["removeXMentions", removeXMentions],
  ["xWeightedLength", xWeightedLength],
  ["truncateXWeighted", (text) => truncateXWeighted(text, 280, "...")],
  ["fitAltText", (text) => fitAltText(text, 1_000)],
  ["cleanAltText", cleanAltText],
  ["hashtagsIn", hashtagsIn],
  ["withoutHashtagSigns", withoutHashtagSigns],
  ["firstName", firstName],
  ["nameInitial", nameInitial],
  ["accountInitials", (text) => accountInitials(text, "kai@example.com")],
  ["accountLabel", (text) => accountLabel(text, "kai@example.com")],
  ["cleanSenderText", cleanSenderText],
  ["cleanSenderText, one line", (text) => cleanSenderText(text, { singleLine: true })],
  ["cleanBrandVoice", cleanBrandVoice],
  ["cleanBrandVoiceExamples", cleanBrandVoiceExamples],
  ["exampleBoxStatus", exampleBoxStatus],
  ["mergeExampleCaptions", (text) => mergeExampleCaptions(text, ["Dawn patrol"])],
  ["cleanAvoidCaptions", (text) => cleanAvoidCaptions([text])],
  ["cleanRecentCaptions", (text) => cleanRecentCaptions([text])],
  ["captionCounter", captionCounter],
  ["youtubeSafeText", youtubeSafeText],
  ["youtubeDescriptionLength", youtubeDescriptionLength],
  ["fitYouTubeDescription", fitYouTubeDescription],
  ["youtubeCountHint", youtubeCountHint],
  ["fitYouTubeTitle", (text) => fitYouTubeTitle(text)],
  ["fitPinterestTitle", fitPinterestTitle],
  ["fitPinterestDescription", fitPinterestDescription],
  ["pinterestDescriptionLength", pinterestDescriptionLength],
  ["pinterestCountHint", pinterestCountHint],
  ["computeTweetText", computeTweetText],
  ["computeLinkedInCommentary", computeLinkedInCommentary],
  ["computeInstagramCaption", computeInstagramCaption],
  ["fitInstagramTags", fitInstagramTags],
  ["computeTikTokCaption", computeTikTokCaption],
  ["computeGbpPostSummary", computeGbpPostSummary],
  ["toLinkedInLittleText", toLinkedInLittleText],
  ["replyBytes", replyBytes],
  ["replyTooLong", replyTooLong],
  ["replyCounter", replyCounter],
  ["workspaceInitials", workspaceInitials],
  ["labelName", labelName],
  ["trackedWebsiteLink", (text) => trackedWebsiteLink(text, "instagram")],
  ["redactLinkTokens", redactLinkTokens],
  ["reportCaption", reportCaption],
];

const COMPOSED: Array<[string, (platform: Platform) => Helper]> = [
  ["buildCaptionWithFooter", (platform) => (text) => buildCaptionWithFooter(text, user, platform)],
  ["buildPlatformPreview", (platform) => (text) => buildPlatformPreview({ platform, caption: text, user })],
  ["platformCaptionCounter", (platform) => (text) => platformCaptionCounter(text, platform, user)],
];

/** How long one call of `helper` on `input` takes, in ms. */
function timeOf(helper: Helper, input: string): number {
  const started = performance.now();
  helper(input);
  return performance.now() - started;
}

/** An input by name, built at any size. */
type Sized = { name: string; at: (size: number) => string };

function sizedInputs(): Sized[] {
  return (Object.keys(RUNS) as RunName[]).flatMap((run): Sized[] => [
    { name: `${run} mid-token`, at: (size) => `#a${runOf(run, size - 3)}b` },
    { name: `${run} after a mention`, at: (size) => `@kai ${runOf(run, size - 6)}x` },
    { name: `${run} between tags`, at: (size) => betweenTags(run, size) },
  ]);
}

/**
 * The fastest of three calls at `small`, and the fastest call at `large`. A
 * pause (the collector, a busy runner) only lengthens a call: on the small
 * input it would hide growth, so the small one is always timed three times;
 * on the large one it could only fake growth, so while it looks too slow it is
 * timed again, up to seven times, until two calls agree within 10% (a pause
 * does not repeat itself so exactly; real growth does).
 */
function fastestPair(helper: Helper, small: string, large: string): { smallMs: number; largeMs: number } {
  let smallMs = Number.POSITIVE_INFINITY;
  for (let round = 0; round < TIMINGS; round += 1) smallMs = Math.min(smallMs, timeOf(helper, small));
  let largeMs = timeOf(helper, large);
  for (let round = 1; round < LARGE_TIMINGS && largeMs > MAX_GROWTH * smallMs; round += 1) {
    const again = timeOf(helper, large);
    const agrees = Math.abs(again - largeMs) <= 0.1 * largeMs;
    largeMs = Math.min(largeMs, again);
    if (agrees) break;
  }
  return { smallMs, largeMs };
}

/**
 * Where `helper` grew faster than linear (doubling the input more than tripled
 * the time) or went over `budgetMs` at SIZE, one line each.
 */
function failures(helper: Helper, budgetMs: number, inputs: Sized[] = sizedInputs()): string[] {
  return inputs.flatMap(({ name, at }) => {
    const found: string[] = [];
    let size = SIZE;
    let { smallMs, largeMs } = fastestPair(helper, at(size / SPAN), at(size));
    if (largeMs > budgetMs) found.push(`${name}: ${Math.round(largeMs)} ms at ${size}, over its ${budgetMs} ms budget`);
    // Too quick at SIZE for a ratio to mean anything: once more at 4x the size,
    // where a quadratic helper is 16x slower. One still too quick there is
    // harmless at any size a caption can have.
    if (largeMs < GROWTH_FLOOR_MS && largeMs >= GROWTH_FLOOR_MS / 16) {
      size = SIZE * 4;
      ({ smallMs, largeMs } = fastestPair(helper, at(size / SPAN), at(size)));
    }
    const grew = () => largeMs >= GROWTH_FLOOR_MS && largeMs > MAX_GROWTH * smallMs;
    // A linear helper can step up once between two sizes (a cache, a string
    // turning flat) and come near 3x; it does not do so again at twice the
    // sizes, while a quadratic helper does at every size. So a first ratio over
    // 3 is checked once more at twice the size, and both must be over.
    if (grew()) {
      const first = `${(largeMs / smallMs).toFixed(1)}x from ${size / SPAN} to ${size}`;
      size *= 2;
      ({ smallMs, largeMs } = fastestPair(helper, at(size / SPAN), at(size)));
      if (grew()) {
        found.push(
          `${name}: grew ${first}, then ${(largeMs / smallMs).toFixed(1)}x from ${size / SPAN} to ${size} characters (${smallMs.toFixed(1)} ms, then ${Math.round(largeMs)} ms)`,
        );
      }
    }
    return found;
  });
}

describe("every helper that walks user text runs in linear time", () => {
  // The clients log each cut; those lines would only slow the run.
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => vi.restoreAllMocks());

  it("the inputs are 16,000 characters each, and every budget keeps a 10x margin", () => {
    for (const [, input] of adversarialInputs()) {
      expect(input.length).toBeGreaterThan(SIZE * 0.99);
      expect(input.length).toBeLessThanOrEqual(SIZE);
    }
    expect(BUDGET_MS).toBeGreaterThanOrEqual(10 * MEASURED_MS.single);
    expect(COMPOSED_BUDGET_MS).toBeGreaterThanOrEqual(10 * MEASURED_MS.composed);
  });

  it.each(HELPERS)("%s: linear growth and within its budget on every input", (_name, helper) => {
    expect(failures(helper, BUDGET_MS)).toEqual([]);
  }, 60_000);

  it.each(platforms)("%s: the composed helpers grow linearly and keep their budget on its own run", (platform) => {
    const run = PLATFORM_RUN[platform];
    const input: Sized = { name: `${run} between tags`, at: (size) => betweenTags(run, size) };
    for (const [name, compose] of COMPOSED) {
      expect(failures(compose(platform), COMPOSED_BUDGET_MS, [input]), name).toEqual([]);
    }
  }, 60_000);

  it("fails on a planted quadratic helper through the growth check alone", () => {
    // The pattern removeXMentions used before R68, which restarts at every
    // comma of a run not at the very end, on the last half of the text: as
    // quadratic, 4x cheaper, so the check at 32,000 stays quick.
    const quadratic = (text: string) => text.slice(text.length / 2).replace(/[,;]+$/, "");
    const commas = sizedInputs().filter(({ name }) => name === "commas after a mention");
    // No budget can fail it here, so only the growth check can.
    const found = failures(quadratic, Number.POSITIVE_INFINITY, commas);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^commas after a mention: grew \d+\.\dx from 8000 to 16000, then \d+\.\dx from 16000 to 32000/);
    // A linear helper on the same input passes.
    expect(failures((text: string) => text.replace(/,+/g, ","), Number.POSITIVE_INFINITY, commas)).toEqual([]);
  }, 60_000);
});
