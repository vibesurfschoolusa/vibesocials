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
 * The budget is 1 s per helper call at 100,000 characters (10 µs a character).
 * A linear helper takes a few ms to about 100 ms at that size, so a loaded CI
 * runner has a 10x margin; a quadratic one takes 10 s or more.
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
const BUDGET_MS_PER_CHAR = 1_000 / SIZE;

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

const HELPERS: Array<[string, (text: string) => unknown]> = [
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
  ...platforms.flatMap((platform): Array<[string, (text: string) => unknown]> => [
    [`buildCaptionWithFooter, ${platform}`, (text) => buildCaptionWithFooter(text, user, platform)],
    [`buildPlatformPreview, ${platform}`, (text) => buildPlatformPreview({ platform, caption: text, user })],
    [`platformCaptionCounter, ${platform}`, (text) => platformCaptionCounter(text, platform, user)],
  ]),
];

/** The inputs on which `helper` took longer than the budget for their size, with the time each took. */
function overBudget(helper: (text: string) => unknown, size: number): string[] {
  const over: string[] = [];
  for (const [name, input] of adversarialInputs(size)) {
    const started = performance.now();
    helper(input);
    const ms = performance.now() - started;
    if (ms > input.length * BUDGET_MS_PER_CHAR) over.push(`${name}: ${Math.round(ms)} ms`);
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

  it.each(HELPERS)("%s: under 1 s on every input", (_name, helper) => {
    expect(overBudget(helper, SIZE)).toEqual([]);
  }, 120_000);

  it("fails on a planted quadratic helper", () => {
    // The pattern removeXMentions used before R68: it restarts at every comma
    // of a run that is not at the very end. At 30,000 characters (a budget of
    // 300 ms) it takes about a second, so the guard sees it without a 10 s wait.
    const quadratic = (text: string) => text.replace(/[,;]+$/, "");
    const over = overBudget(quadratic, 30_000);
    expect(over.some((line) => line.startsWith("commas after a mention"))).toBe(true);
    // A linear helper on the same inputs passes.
    expect(overBudget((text: string) => text.replace(/,+/g, ","), 30_000)).toEqual([]);
  }, 60_000);
});
