import type { Platform } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountInitials, accountLabel, firstName, nameInitial } from "@/lib/accountInitials";
import { cleanAltText, fitAltText } from "@/lib/altText";
import { cleanBrandVoice, cleanBrandVoiceExamples, exampleBoxStatus } from "@/lib/brandVoice";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import { captionCounter } from "@/lib/captionLimits";
import { cleanAvoidCaptions, cleanRecentCaptions } from "@/lib/captionVariety";
import { hashtagsIn, withoutHashtagSigns } from "@/lib/hashtags";
import { fitPinterestDescription, fitPinterestTitle, pinterestCountHint, pinterestDescriptionLength } from "@/lib/pinterestApi";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { platformCaptionCounter } from "@/lib/platformOverrides";
import { buildPlatformPreview } from "@/lib/platformPreview";
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
 * exported helper that walks user text on adversarial inputs of 100,000
 * characters, so a new super-linear one fails here.
 *
 * The budget is 1 s a call at 100,000 characters. A single helper takes
 * 1-100 ms there, so a loaded CI runner has a 10x margin. The composed ones
 * (buildCaptionWithFooter, buildPlatformPreview, platformCaptionCounter) run
 * several of the others, up to about 460 ms (the X counter, linear: 0.9 s at
 * 200,000), so theirs is 5 s. A quadratic helper takes 10 s or more at
 * 100,000 (removeXMentions took 11 s), so it fails either budget.
 *
 * Left out, each for a reason:
 * - jpegFileName (prepareUploadFile.ts): its /[. ]+$/ is quadratic, but its
 *   input is a file name, at most 255 characters on every file system.
 * - captionVarietyBlock, brandVoicePrompt, workspaceBrandVoicePrompt: they
 *   only join text the clean functions timed here already capped.
 * - isUploadLinkTokenShape and the other shape tests: an anchored pattern
 *   with no nested repeat, so linear by construction.
 */

const SIZE = 100_000;
const BUDGET_MS = 1_000;
const COMPOSED_BUDGET_MS = 5_000;

/** The runs a pattern or a walk may restart on, each one character or grapheme repeated. */
const RUNS: Array<[string, string]> = [
  ["commas", ","],
  ["semicolons", ";"],
  ["commas and semicolons", ",;"],
  ["spaces", " "],
  ["dots", "."],
  ["dotted labels", "a."],
  ["hyphens", "-"],
  ["at signs", "@"],
  ["mentions", "@a"],
  ["hash signs", "#"],
  ["hashtags", "#a"],
  ["combining marks", "́"],
  ["emoji", "\u{1F30A}"],
  ["ZWJ chain", "\u{1F468}‍"],
  ["line breaks", "\n"],
];

/** Each run mid-token, after a mention, and between tags, filled to `size` characters. */
function adversarialInputs(size: number): Array<[string, string]> {
  const inputs: Array<[string, string]> = [];
  for (const [name, unit] of RUNS) {
    const run = (room: number) => unit.repeat(Math.max(1, Math.floor(room / unit.length)));
    inputs.push([`${name} mid-token`, `#a${run(size - 3)}b`]);
    inputs.push([`${name} after a mention`, `@kai ${run(size - 6)}x`]);
    inputs.push([`${name} between tags`, `#a ${run(size - 11)} @kai #b`]);
  }
  return inputs;
}

const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves @kai", trackWebsiteLinks: true };
const platforms = Object.keys(PLATFORM_CAPTION_LIMITS) as Platform[];

type Helper = (text: string) => unknown;

const HELPERS: Array<[string, Helper, number?]> = [
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
  ...platforms.flatMap((platform): Array<[string, Helper, number]> => [
    [`buildCaptionWithFooter, ${platform}`, (text) => buildCaptionWithFooter(text, user, platform), COMPOSED_BUDGET_MS],
    [`buildPlatformPreview, ${platform}`, (text) => buildPlatformPreview({ platform, caption: text, user }), COMPOSED_BUDGET_MS],
    [`platformCaptionCounter, ${platform}`, (text) => platformCaptionCounter(text, platform, user), COMPOSED_BUDGET_MS],
  ]),
];

/**
 * The inputs of `size` characters (those whose name starts with `only`, when
 * given) on which `helper` took longer than `budgetMs` scaled to that size,
 * each with the time it took.
 */
function overBudget(helper: Helper, budgetMs: number, size = SIZE, only = ""): string[] {
  const over: string[] = [];
  for (const [name, input] of adversarialInputs(size)) {
    if (!name.startsWith(only)) continue;
    const started = performance.now();
    helper(input);
    const ms = performance.now() - started;
    if (ms > (budgetMs * input.length) / SIZE) over.push(`${name}: ${Math.round(ms)} ms`);
  }
  return over;
}

describe("every helper that walks user text runs in linear time", () => {
  // The clients log each cut; thousands of those lines would only slow the run.
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => vi.restoreAllMocks());

  it("the inputs are 100,000 characters each", () => {
    for (const [, input] of adversarialInputs(SIZE)) {
      expect(input.length).toBeGreaterThan(SIZE * 0.99);
      expect(input.length).toBeLessThanOrEqual(SIZE);
    }
  });

  it.each(HELPERS)("%s: within its budget on every input", (_name, helper, budgetMs = BUDGET_MS) => {
    expect(overBudget(helper, budgetMs)).toEqual([]);
  }, 120_000);

  it("fails on a planted quadratic helper", () => {
    // The pattern removeXMentions used before R68: it restarts at every comma
    // of a run that is not at the very end. At 30,000 characters (a budget of
    // 300 ms) it takes about a second, so the guard sees it without a 10 s wait.
    const quadratic = (text: string) => text.replace(/[,;]+$/, "");
    expect(overBudget(quadratic, BUDGET_MS, 30_000, "commas after a mention")).toHaveLength(1);
    // A linear helper on the same input passes.
    expect(overBudget((text: string) => text.replace(/,+/g, ","), BUDGET_MS, 30_000, "commas after a mention")).toEqual([]);
  }, 60_000);
});
