import { describe, expect, it } from "vitest";

import {
  dailyPostLimitMessage,
  newAccountPoolMessage,
  ownerDailyPostLimitMessage,
  serviceDailyPostLimitMessage,
} from "./usageLimits";

// R55 pages-a-3 L1: a card awaiting approval has no "another day" to pick, so the
// approval route says the same facts with steps the approver can take. Every other
// caller's sentence stays byte-identical: pinned here, whole.
const time = { now: new Date("2026-11-20T15:00:00Z"), timeZone: null };
const holder = { name: "Sam", coOwned: true, isViewer: false };

const original = {
  wsNow: "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again in 9 hours.",
  wsSched: "That day already has 20 posts, which is this workspace's daily limit. Pick another day.",
  ownNow: "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again in 9 hours.",
  ownSched: "That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). Pick another day.",
  ownNamedNow: "Sam, an owner of this workspace, has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again in 9 hours.",
  ownNamedSched: "Sam, an owner of this workspace, already has 15 posts that day across the workspaces they own, which is the daily limit for one person (retries count toward it). Pick another day.",
  svcNow: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again in 9 hours.",
  svcSched: "That day is full: Vibe Socials has reached its daily limit of posts for the whole service. Pick another day.",
  poolNow: "Vibe Socials has reached today's limit of 5 posts shared by accounts made today (UTC) or with an unconfirmed email address. Schedule this post for another day, or try again in 9 hours. It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.",
  poolSched: "That day is full: Vibe Socials has reached the limit of 5 posts a day shared by accounts made today (UTC) or with an unconfirmed email address. Pick another day. It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.",
};

describe("the limit sentences other callers read are unchanged", () => {
  it("workspace", () => {
    expect(dailyPostLimitMessage(20, "now", time)).toBe(original.wsNow);
    expect(dailyPostLimitMessage(20, "schedule", time)).toBe(original.wsSched);
  });
  it("per person, unnamed and named", () => {
    expect(ownerDailyPostLimitMessage(15, "now", null, null, time, {})).toBe(original.ownNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, null, time, {})).toBe(original.ownSched);
    expect(ownerDailyPostLimitMessage(15, "now", null, holder, time, {})).toBe(original.ownNamedNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {})).toBe(original.ownNamedSched);
  });
  it("service and new-account pool", () => {
    expect(serviceDailyPostLimitMessage("now", time)).toBe(original.svcNow);
    expect(serviceDailyPostLimitMessage("schedule", time)).toBe(original.svcSched);
    expect(newAccountPoolMessage("now", time)).toBe(original.poolNow);
    expect(newAccountPoolMessage("schedule", time)).toBe(original.poolSched);
  });
});

// R57 publishing-flow L3: the approval sentence stays under the card, so its reset is a fixed time, never a countdown.
const RESET = "from 00:00 UTC on November 21, 2026";
const NOTE =
  "It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.";
const viewer = { name: "Sam", coOwned: true, isViewer: true };

/*
 * R57 fix review: one rule for every approval ending. Each limit offers only
 * the steps true for it, and a step that may not apply is a condition:
 * - the pools (runs already gone out): no slot to free, only the wait or room;
 * - the workspace limit: this workspace's own posts on that day;
 * - the per-person limit: that owner's posts across their workspaces, as a
 *   step for the reader when they are that owner, else as what the named owner can do.
 * Then the wait (a fixed reset) or room, and reject, as before.
 */
const REST_DAY = "approve it again once that day has room, or reject it and ask the member to submit it for another day.";
const REST_NOW = `approve it again ${RESET}, or reject it and ask the member to schedule it for another day.`;
const REST_TODAY = `approve it again ${RESET}, when it publishes at once, or reject it and ask the member to schedule it for another day.`;
const POOL_DAY = "Approve it again once that day has room, or reject it and ask the member to submit it for another day.";
const POOL_NOW = `Approve it again ${RESET}, or reject it and ask the member to schedule it for another day.`;
const POOL_TODAY = `Approve it again ${RESET}; it then publishes at once. Or reject it and ask the member to schedule it for another day.`;

const freeWs = (day: string) => `If another post here is still scheduled for ${day}, cancel or move it, then approve again.`;
const freeYou = (day: string) =>
  `If you have another post still scheduled for ${day}, in any of those workspaces, cancel or move it, then approve again.`;
// R58 publishing-flow L1: a per-person refusal happens only when this workspace
// is free, so it is always one of the counted ones and its posts are the
// approver's to cancel or move. The holder's other workspaces come second.
const freeSam = (day: string) =>
  `If another post here is still scheduled for ${day}, cancel or move it, then approve again. Sam can also free one in another of those workspaces.`;
const freeOwner = (day: string) =>
  `If this workspace's owner has another post still scheduled for ${day}, they can cancel or move it to make room.`;

const WS_NOW = "This workspace has reached its limit of 20 posts for today.";
const WS_DAY = "That day already has 20 posts, which is this workspace's daily limit.";
const OWN_NOW =
  "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it.";
const OWN_DAY =
  "That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it).";
const SAM_NOW =
  "Sam, an owner of this workspace, has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it.";
const SAM_DAY =
  "Sam, an owner of this workspace, already has 15 posts that day across the workspaces they own, which is the daily limit for one person (retries count toward it).";
const SVC_NOW = "Vibe Socials has reached its daily limit of posts for the whole service.";
const SVC_DAY = "That day is full: Vibe Socials has reached its daily limit of posts for the whole service.";
const POOLX_NOW =
  "Vibe Socials has reached today's limit of 5 posts shared by accounts made today (UTC) or with an unconfirmed email address.";
const POOLX_DAY =
  "That day is full: Vibe Socials has reached the limit of 5 posts a day shared by accounts made today (UTC) or with an unconfirmed email address.";

/** Every approval sentence, by limit and case: `now` (publish now), `today` (a slot later today), `future` (another day). */
const approval = {
  wsNow: `${WS_NOW} ${freeWs("today")} Or ${REST_NOW}`,
  wsToday: `${WS_DAY} ${freeWs("that day")} Or ${REST_TODAY}`,
  wsFuture: `${WS_DAY} ${freeWs("that day")} Or ${REST_DAY}`,
  youNow: `${OWN_NOW} ${freeYou("today")} Or ${REST_NOW}`,
  youToday: `${OWN_DAY} ${freeYou("that day")} Or ${REST_TODAY}`,
  youFuture: `${OWN_DAY} ${freeYou("that day")} Or ${REST_DAY}`,
  samNow: `${SAM_NOW} ${freeSam("today")} Or ${REST_NOW}`,
  samToday: `${SAM_DAY} ${freeSam("that day")} Or ${REST_TODAY}`,
  samFuture: `${SAM_DAY} ${freeSam("that day")} Or ${REST_DAY}`,
  ownerNow: `${OWN_NOW} ${freeOwner("today")} Or ${REST_NOW}`,
  ownerToday: `${OWN_DAY} ${freeOwner("that day")} Or ${REST_TODAY}`,
  ownerFuture: `${OWN_DAY} ${freeOwner("that day")} Or ${REST_DAY}`,
  svcNow: `${SVC_NOW} ${POOL_NOW}`,
  svcToday: `${SVC_DAY} ${POOL_TODAY}`,
  svcFuture: `${SVC_DAY} ${POOL_DAY}`,
  poolNow: `${POOLX_NOW} ${POOL_NOW} ${NOTE}`,
  poolToday: `${POOLX_DAY} ${POOL_TODAY} ${NOTE}`,
  poolFuture: `${POOLX_DAY} ${POOL_DAY} ${NOTE}`,
};

const own = (mode: "now" | "schedule", who: typeof holder | null, today = false) =>
  ownerDailyPostLimitMessage(15, mode, null, who, time, {}, "approval", today);

describe("approval endings, one rule: the workspace limit", () => {
  it("today", () => expect(dailyPostLimitMessage(20, "schedule", time, "approval", true)).toBe(approval.wsToday));
  it("a future day", () => expect(dailyPostLimitMessage(20, "schedule", time, "approval", false)).toBe(approval.wsFuture));
  it("publish now", () => expect(dailyPostLimitMessage(20, "now", time, "approval")).toBe(approval.wsNow));
});

describe("approval endings, one rule: per person, the reader is the spent owner", () => {
  it("today", () => expect(own("schedule", viewer, true)).toBe(approval.youToday));
  it("a future day", () => expect(own("schedule", viewer)).toBe(approval.youFuture));
  it("publish now", () => expect(own("now", viewer)).toBe(approval.youNow));
});

// R57 second look: the per-person number counts only the owner's workspaces the
// limit applies to (with billing on, those not yet paid for), so the step points
// back at the workspaces the sentence names rather than at every one they own.
describe("approval endings, one rule: the spent owner's step names only the workspaces that count", () => {
  const STEP = "If you have another post still scheduled for that day, in any of those workspaces, cancel or move it, then approve again.";
  it("billing off: every workspace they own", () => {
    const text = ownerDailyPostLimitMessage(15, "schedule", null, viewer, time, {}, "approval");
    expect(text).toContain(`across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). ${STEP}`);
  });
  it("billing on: their workspaces not yet paid for", () => {
    const text = ownerDailyPostLimitMessage(15, "schedule", null, viewer, time, { BILLING_ENABLED: "true" }, "approval");
    expect(text).toContain(`across this workspace's owner's workspaces not yet paid for, which is the daily limit for one person (retries count toward it). ${STEP}`);
    const now = ownerDailyPostLimitMessage(15, "now", null, viewer, time, { BILLING_ENABLED: "true" }, "approval");
    expect(now).toContain("across their workspaces not yet paid for, and retries count toward it. If you have another post still scheduled for today, in any of those workspaces,");
  });
  it("never claims every workspace they own", () => {
    for (const env of [{}, { BILLING_ENABLED: "true" }]) {
      for (const mode of ["now", "schedule"] as const) {
        expect(ownerDailyPostLimitMessage(15, mode, null, viewer, time, env, "approval")).not.toMatch(/in any workspace you own/);
      }
    }
  });
});

describe("approval endings, one rule: per person, a named co-owner", () => {
  it("today", () => expect(own("schedule", holder, true)).toBe(approval.samToday));
  it("a future day", () => expect(own("schedule", holder)).toBe(approval.samFuture));
  it("publish now", () => expect(own("now", holder)).toBe(approval.samNow));
});

describe("approval endings: a named co-owner's step never leaves the approver only waiting", () => {
  it("offers this workspace's step first, today, a future day and publish now", () => {
    for (const text of [own("schedule", holder, true), own("schedule", holder), own("now", holder)]) {
      expect(text).toMatch(/ If another post here is still scheduled for (today|that day), cancel or move it, then approve again\. Sam can also free one/);
      expect(text).not.toMatch(/they can cancel or move it to make room/);
    }
  });
  it("billing on: the other workspaces are the ones the sentence names", () => {
    const text = ownerDailyPostLimitMessage(15, "schedule", null, holder, time, { BILLING_ENABLED: "true" }, "approval");
    expect(text).toContain("their workspaces not yet paid for, which is the daily limit for one person (retries count toward it). If another post here");
    expect(text).toContain("Sam can also free one in another of those workspaces.");
  });
});

describe("approval endings, one rule: per person, an owner not known to be the reader", () => {
  it("today, a future day, publish now", () => {
    expect(own("schedule", null, true)).toBe(approval.ownerToday);
    expect(own("schedule", null)).toBe(approval.ownerFuture);
    expect(own("now", null)).toBe(approval.ownerNow);
  });
});

describe("approval endings, one rule: the pools offer no slot to free", () => {
  it("service-wide", () => {
    expect(serviceDailyPostLimitMessage("now", time, "approval")).toBe(approval.svcNow);
    expect(serviceDailyPostLimitMessage("schedule", time, "approval", true)).toBe(approval.svcToday);
    expect(serviceDailyPostLimitMessage("schedule", time, "approval", false)).toBe(approval.svcFuture);
  });
  it("new-account pool", () => {
    expect(newAccountPoolMessage("now", time, "approval")).toBe(approval.poolNow);
    expect(newAccountPoolMessage("schedule", time, "approval", true)).toBe(approval.poolToday);
    expect(newAccountPoolMessage("schedule", time, "approval", false)).toBe(approval.poolFuture);
  });
});

describe("approval endings, one rule: what holds across every case", () => {
  it("only the workspace and per-person limits offer a slot to free, always as a condition", () => {
    for (const [key, text] of Object.entries(approval)) {
      const pool = key.startsWith("svc") || key.startsWith("pool");
      expect(/cancel or move/i.test(text), key).toBe(!pool);
      if (!pool) expect(text, key).toMatch(/ If [^.]* still scheduled for (today|that day)/);
    }
  });
  it("no pick-another-day wording, no countdown", () => {
    for (const text of Object.values(approval)) {
      expect(text).not.toMatch(/Pick another day|Schedule this post|try again| in \d+ (hour|minute)/);
    }
  });
  it("a reduced per-person number keeps its note after the ending", () => {
    expect(ownerDailyPostLimitMessage(5, "schedule", "unconfirmed", viewer, time, {}, "approval")).toMatch(
      /in any of those workspaces, cancel or move it, then approve again\. Or approve it again once that day has room, .*\. The limit is 15 once you confirm your email address\.$/,
    );
  });
  it("the default sentences stay byte-identical, today or not", () => {
    expect(dailyPostLimitMessage(20, "schedule", time, "default", true)).toBe(original.wsSched);
    expect(dailyPostLimitMessage(20, "now", time, "default", true)).toBe(original.wsNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {}, "default", true)).toBe(original.ownNamedSched);
    expect(ownerDailyPostLimitMessage(15, "now", null, viewer, time, {})).toBe(original.ownNow);
    expect(serviceDailyPostLimitMessage("schedule", time, "default", true)).toBe(original.svcSched);
    expect(newAccountPoolMessage("schedule", time, "default", true)).toBe(original.poolSched);
  });
});

// R57 publishing-flow L3: the refusal stays under the card until the next press,
// and the Queue does not reload on its own, so "in 9 hours" goes stale.
describe("an approval sentence names its reset as a fixed time", () => {
  const zoned = { now: time.now, timeZone: "America/New_York" };
  it("with the reader's time zone: their time and 00:00 UTC", () => {
    expect(dailyPostLimitMessage(20, "now", zoned, "approval")).toBe(
      approval.wsNow.replace(RESET, "from Friday, 7:00 PM EST (00:00 UTC)"),
    );
    expect(serviceDailyPostLimitMessage("schedule", zoned, "approval", true)).toBe(
      approval.svcToday.replace(RESET, "from Friday, 7:00 PM EST (00:00 UTC)"),
    );
  });
  it("without one: the UTC moment", () => {
    expect(dailyPostLimitMessage(20, "now", time, "approval")).toContain(`Or approve it again ${RESET}, or reject it`);
  });
  it("the default sentences keep their countdown without a zone, and their zoned form with one", () => {
    expect(dailyPostLimitMessage(20, "now", time)).toBe(original.wsNow);
    expect(dailyPostLimitMessage(20, "now", zoned)).toBe(
      "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again from Friday, 7:00 PM EST (00:00 UTC).",
    );
  });
});
