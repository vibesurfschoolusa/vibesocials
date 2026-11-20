import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SEND_AGAIN_MAX_AGE_DAYS,
  sendAgainTooOld,
  STORY_TOO_OLD_TO_SEND_MESSAGE,
  TOO_OLD_TO_SEND_MESSAGE,
  tooOldToSendText,
} from "./sendAgain";

// Live check after F1: a post from months ago offered Send again, which would
// publish stale content today. Only a recent unsent post may be sent again.
describe("sendAgainTooOld", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  it("allows a post scheduled within the last week", () => {
    expect(sendAgainTooOld({ scheduledFor: daysAgo(6.9), createdAt: daysAgo(30) }, now)).toBe(false);
  });

  it("refuses a post scheduled more than a week ago", () => {
    expect(sendAgainTooOld({ scheduledFor: daysAgo(7.1), createdAt: daysAgo(1) }, now)).toBe(true);
  });

  it("uses the creation time when the post had no time", () => {
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: daysAgo(2) }, now)).toBe(false);
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: daysAgo(300) }, now)).toBe(true);
  });

  it("takes Date objects too (the server's rows)", () => {
    expect(sendAgainTooOld({ scheduledFor: new Date(now - 86_400_000), createdAt: null }, now)).toBe(false);
  });

  it("treats a post with no time at all as too old to judge, so it is not sent", () => {
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: null }, now)).toBe(true);
  });

  it("says so plainly", () => {
    expect(SEND_AGAIN_MAX_AGE_DAYS).toBe(7);
    expect(TOO_OLD_TO_SEND_MESSAGE).toBe(
      "This post was not sent, and it is too old to send again. Create it again if you still want it.",
    );
  });
});

// R49 pages-b L1 (5b): the card and the publish route say the one too-old sentence for the job.
// R50 pages-b L2: the Story's names its platforms, since Create starts with
// every connected platform ticked and the step must not post the feed again.
describe("tooOldToSendText", () => {
  it("names Instagram for an Instagram Story half", () => {
    expect(tooOldToSendText(true, ["instagram"])).toBe(
      "This Story was not sent, and it is too old to send again. To post it, create a new post to Instagram only, with Story chosen.",
    );
  });

  it("names both platforms for a Story on Instagram and Facebook", () => {
    expect(tooOldToSendText(true, ["facebook_page", "instagram"])).toBe(
      "This Story was not sent, and it is too old to send again. To post it, create a new post to Instagram and Facebook Page only, with Story chosen.",
    );
  });

  it("falls back to a step that still ticks only the Story's platform when the list is empty or unknown", () => {
    expect(tooOldToSendText(true, [])).toBe(STORY_TOO_OLD_TO_SEND_MESSAGE);
    expect(tooOldToSendText(true, null)).toBe(STORY_TOO_OLD_TO_SEND_MESSAGE);
    expect(tooOldToSendText(true)).toBe(STORY_TOO_OLD_TO_SEND_MESSAGE);
  });

  it("keeps the feed post's sentence, whatever platforms are passed", () => {
    expect(tooOldToSendText(false)).toBe(TOO_OLD_TO_SEND_MESSAGE);
    expect(tooOldToSendText(false, ["instagram"])).toBe(TOO_OLD_TO_SEND_MESSAGE);
  });
});

// R49 review: a reason ("so the feed post is not sent twice") is false when the
// feed half failed too, so the Story's sentence gives only the step.
describe("STORY_TOO_OLD_TO_SEND_MESSAGE", () => {
  it("says what happened and a step that ticks only the Story's platform, with no reason clause", () => {
    expect(STORY_TOO_OLD_TO_SEND_MESSAGE).toBe(
      "This Story was not sent, and it is too old to send again. To post it, create a new post with only the Story's platform ticked and Story chosen.",
    );
    expect(STORY_TOO_OLD_TO_SEND_MESSAGE).not.toMatch(/feed|twice|so /i);
  });

  it("is said by the publish route's 409 and the Activity card through tooOldToSendText only", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    for (const source of [read("../app/api/posts/[postJobId]/publish/route.ts"), read("../components/activity/post-job-card.tsx")]) {
      expect(source).toMatch(/tooOldToSendText\(/);
      expect(source).not.toMatch(/STORY_TOO_OLD_TO_SEND_MESSAGE|TOO_OLD_TO_SEND_MESSAGE|too old to send again/);
    }
  });
});
