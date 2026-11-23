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
 * The inputs are 30,000 characters: a quadratic helper takes about a second
 * there (the planted one below: 1.0 s), a linear one a few ms (at most 52 ms).
 * Each budget is at least 10x the slowest linear call measured
 * (MEASURED_MS), so a loaded CI runner does not flake.
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

const SIZE = 30_000;
// The slowest linear calls measured at 30,000 characters (2026-11-22, this
// machine): a single helper, and a composed one on its platform's run.
const MEASURED_MS = { single: 52, composed: 84 };
const BUDGET_MS = 550;
const COMPOSED_BUDGET_MS = 1_000;

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
  "combining marks": "́",
  emoji: "\u{1F30A}",
  "ZWJ chain": "\u{1F468}‍",
  "line breaks": "\n",
} as const;
type RunName = keyof typeof RUNS;

/** `unit` repeated to fill about `room` characters. */
function runOf(name: RunName, room: number): string {
  const unit = RUNS[name];
  return unit.repeat(Math.max(1, Math.floor(room / unit.length)));
}

/** One run between tags, filled to `SIZE` characters. */
function betweenTags(name: RunName): string {
  return `#a ${runOf(name, SIZE - 11)} @kai #b`;
}

/** Each run mid-token, after a mention, and between tags, filled to `SIZE` characters. */
function adversarialInputs(): Array<[string, string]> {
  return (Object.keys(RUNS) as RunName[]).flatMap((name): Array<[string, string]> => [
    [`${name} mid-token`, `#a${runOf(name, SIZE - 3)}b`],
    [`${name} after a mention`, `@kai ${runOf(name, SIZE - 6)}x`],
    [`${name} between tags`, betweenTags(name)],
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

/** The inputs on which `helper` took longer than `budgetMs`, each with the time it took. */
function overBudget(helper: Helper, budgetMs: number, inputs = adversarialInputs()): string[] {
  return inputs.flatMap(([name, input]) => {
    const started = performance.now();
    helper(input);
    const ms = performance.now() - started;
    return ms > budgetMs ? [`${name}: ${Math.round(ms)} ms`] : [];
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

  it("the inputs are 30,000 characters each, and every budget keeps a 10x margin", () => {
    for (const [, input] of adversarialInputs()) {
      expect(input.length).toBeGreaterThan(SIZE * 0.99);
      expect(input.length).toBeLessThanOrEqual(SIZE);
    }
    expect(BUDGET_MS).toBeGreaterThanOrEqual(10 * MEASURED_MS.single);
    expect(COMPOSED_BUDGET_MS).toBeGreaterThanOrEqual(10 * MEASURED_MS.composed);
  });

  it.each(HELPERS)("%s: within its budget on every input", (_name, helper) => {
    expect(overBudget(helper, BUDGET_MS)).toEqual([]);
  }, 60_000);

  it.each(platforms)("%s: the composed helpers within their budget on its own run", (platform) => {
    const run = PLATFORM_RUN[platform];
    for (const [name, compose] of COMPOSED) {
      expect(overBudget(compose(platform), COMPOSED_BUDGET_MS, [[`${run} between tags`, betweenTags(run)]]), name).toEqual(
        [],
      );
    }
  }, 60_000);

  it("fails on a planted quadratic helper", () => {
    // The pattern removeXMentions used before R68: it restarts at every comma
    // of a run that is not at the very end.
    const quadratic = (text: string) => text.replace(/[,;]+$/, "");
    const commas = adversarialInputs().filter(([name]) => name === "commas after a mention");
    expect(overBudget(quadratic, BUDGET_MS, commas)).toHaveLength(1);
    // A linear helper on the same input passes.
    expect(overBudget((text: string) => text.replace(/,+/g, ","), BUDGET_MS, commas)).toEqual([]);
  }, 60_000);
});
