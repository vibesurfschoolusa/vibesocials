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
 * - Growth: a linear helper about doubles when its input doubles, a quadratic
 *   one about quadruples. A helper fails only when it BOTH grows more than 3x
 *   at each doubling from 8,000 to 16,000 to 32,000 AND costs over 200 ms at
 *   32,000, and then grows more than 3x once more at 64,000. Growth at tens of
 *   ms is noise on a CI runner (the collector, the JIT, ICU), so those ratios
 *   only go to the log (letThrough); a quadratic helper that matters costs
 *   about 1 s at 32,000.
 *   - A pause only lengthens a call. The small size is always timed three
 *     times, fastest counts, so a pause there is unlikely to hide growth; a
 *     larger one is re-timed while it looks too slow, so pauses there are
 *     unlikely to fake it.
 * - A backstop budget at 16,000 characters for gross cases, 3x the slowest
 *   linear call on CI (MEASURED_CI_MS).
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
/** Doubling the input may at most triple the time. */
const MAX_GROWTH = 3;
/**
 * Growth fails only for a helper this slow at 32,000 characters: a real
 * quadratic one costs about 1 s there (removeXMentions and mergeExampleCaptions
 * before R68), a linear one at most about 45 ms here and 150 ms on CI.
 */
const MATERIAL_MS = 200;
/** The small size is always timed this many times, and the fastest call counts. */
const TIMINGS = 3;
/**
 * A larger size is timed up to this many times while it looks too slow: on a
 * busy runner the system can stop any one call for a time slice, which would
 * fake growth in a call of a few ms.
 */
const LARGE_TIMINGS = 7;
// The slowest linear calls at 16,000 characters: 22 ms (a single helper) and
// 42 ms (a composed one) here; GitHub's Linux runner is about 3x slower.
const MEASURED_CI_MS = { single: 66, composed: 126 };
// Backstops for gross cases only, 3x the slowest linear call on CI.
const BUDGET_MS = 200;
const COMPOSED_BUDGET_MS = 380;

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

/**
 * An input by name, built at any size. Each run sits after a mention (a run
 * that is not at the very end, the shape that made /[,;]+$/ quadratic) and
 * between tags (the footer code's shape).
 */
type Sized = { name: string; at: (size: number) => string };

function sizedInputs(): Sized[] {
  return (Object.keys(RUNS) as RunName[]).flatMap((run): Sized[] => [
    { name: `${run} after a mention`, at: (size) => `@kai ${runOf(run, size - 6)}x` },
    { name: `${run} between tags`, at: (size) => betweenTags(run, size) },
  ]);
}

/**
 * The fastest call on `input`, timed once and again (up to LARGE_TIMINGS in
 * all) while it looks more than 3x `previousMs`, until two calls agree within
 * 10%: a pause (the collector, a busy runner) only lengthens a call, so it can
 * fake growth here, and it does not repeat itself so exactly.
 */
function fastestAfter(helper: Helper, input: string, previousMs: number): number {
  let ms = timeOf(helper, input);
  for (let round = 1; round < LARGE_TIMINGS && ms > MAX_GROWTH * previousMs; round += 1) {
    const again = timeOf(helper, input);
    const agrees = Math.abs(again - ms) <= 0.1 * ms;
    ms = Math.min(ms, again);
    if (agrees) break;
  }
  return ms;
}

/** Ratios over 3 that the cost rule let through, for the run's log. */
const letThrough: string[] = [];

/**
 * Where `helper` went over `budgetMs` at SIZE, or grew like a quadratic helper
 * that matters, one line each. The second needs all of: more than 3x from 8,000
 * to 16,000 and from 16,000 to 32,000, over MATERIAL_MS at 32,000, and more
 * than 3x again from 32,000 to 64,000.
 */
function failures(helper: Helper, budgetMs: number, inputs: Sized[] = sizedInputs(), label = ""): string[] {
  return inputs.flatMap(({ name, at }) => {
    const found: string[] = [];
    const input16 = at(SIZE);
    // Over its budget once could be a pause, so the fastest of three counts.
    let ms16 = timeOf(helper, input16);
    for (let round = 1; round < TIMINGS && ms16 > budgetMs; round += 1) ms16 = Math.min(ms16, timeOf(helper, input16));
    if (ms16 > budgetMs) found.push(`${name}: ${Math.round(ms16)} ms at ${SIZE}, over its ${budgetMs} ms budget`);
    // A helper over MATERIAL_MS at 32,000 that grows 3x a step is over a
    // quarter of it at 16,000; one quicker than that cannot fail the growth
    // check, so it is not timed further (a pause here only makes it slower).
    if (ms16 <= MATERIAL_MS / 4) return found;
    // The small size is timed three times: a pause there would hide growth.
    let ms8 = Number.POSITIVE_INFINITY;
    for (let round = 0; round < TIMINGS; round += 1) ms8 = Math.min(ms8, timeOf(helper, at(SIZE / 2)));
    if (ms16 > MAX_GROWTH * ms8) ms16 = Math.min(ms16, fastestAfter(helper, input16, ms8));
    if (ms16 <= MAX_GROWTH * ms8) return found;
    const ms32 = fastestAfter(helper, at(SIZE * 2), ms16);
    const steps = `${(ms16 / ms8).toFixed(1)}x from ${SIZE / 2} to ${SIZE}, then ${(ms32 / ms16).toFixed(1)}x to ${SIZE * 2} (${Math.round(ms32)} ms)`;
    if (ms32 <= MAX_GROWTH * ms16) return found;
    if (ms32 <= MATERIAL_MS) {
      letThrough.push(`${label}${name}: ${steps}, under ${MATERIAL_MS} ms`);
      return found;
    }
    // Once at 64,000 before failing; a pause here could only make it slower.
    const ms64 = timeOf(helper, at(SIZE * 4));
    if (ms64 > MAX_GROWTH * ms32) {
      found.push(`${name}: grew ${steps}, then ${(ms64 / ms32).toFixed(1)}x to ${SIZE * 4} (${Math.round(ms64)} ms)`);
    } else {
      letThrough.push(`${label}${name}: ${steps}, then ${(ms64 / ms32).toFixed(1)}x to ${SIZE * 4}`);
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
  afterAll(() => {
    vi.restoreAllMocks();
    // Growth over 3x that cost too little to matter: logged, so a trend shows.
    if (letThrough.length > 0) console.info(`linearText guard, let through by the cost rule:\n${letThrough.join("\n")}`);
  });

  it("the inputs are 16,000 characters each, and the budgets are generous", () => {
    for (const { at } of sizedInputs()) {
      expect(at(SIZE).length).toBeGreaterThan(SIZE * 0.99);
      expect(at(SIZE).length).toBeLessThanOrEqual(SIZE);
    }
    expect(BUDGET_MS).toBeGreaterThanOrEqual(2 * MEASURED_CI_MS.single);
    expect(COMPOSED_BUDGET_MS).toBeGreaterThanOrEqual(2 * MEASURED_CI_MS.composed);
  });

  it.each(HELPERS)("%s: no costly quadratic growth, and within its budget on every input", (name, helper) => {
    expect(failures(helper, BUDGET_MS, sizedInputs(), `${name}, `)).toEqual([]);
  }, 60_000);

  it.each(platforms)("%s: the composed helpers, on its own run", (platform) => {
    const run = PLATFORM_RUN[platform];
    const input: Sized = { name: `${run} between tags`, at: (size) => betweenTags(run, size) };
    for (const [name, compose] of COMPOSED) {
      expect(failures(compose(platform), COMPOSED_BUDGET_MS, [input], `${name} ${platform}, `), name).toEqual([]);
    }
  }, 60_000);

  it("fails on a planted quadratic helper through the growth check alone", () => {
    // The pattern removeXMentions used before R68, which restarts at every
    // comma of a run not at the very end, on the last 60% of the text: as
    // quadratic, about 400 ms at 32,000 here (twice MATERIAL_MS), and cheaper
    // than the whole pattern at 64,000.
    const quadratic = (text: string) => text.slice((text.length * 2) / 5).replace(/[,;]+$/, "");
    const commas = sizedInputs().filter(({ name }) => name === "commas after a mention");
    // No budget can fail it here, so only the growth check can.
    const found = failures(quadratic, Number.POSITIVE_INFINITY, commas);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^commas after a mention: grew \d+\.\dx from 8000 to 16000, then \d+\.\dx to 32000 \(\d+ ms\), then \d+\.\dx to 64000/);
    // A linear helper on the same input passes.
    expect(failures((text: string) => text.replace(/,+/g, ","), Number.POSITIVE_INFINITY, commas)).toEqual([]);
  }, 60_000);
});
