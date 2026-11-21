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

const SCHEDULED_STEPS = "Approve it again once that day has room, or reject it and ask the member to submit it for another day.";
const nowSteps = (reset: string) =>
  `Approve it again ${reset}, or reject it and ask the member to schedule it for another day.`;

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

const RESET = "in 9 hours";
const NOTE =
  "It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.";
const approval = {
  wsNow: `This workspace has reached its limit of 20 posts for today. ${nowSteps(RESET)}`,
  // Its count is this workspace's own posts, so the approver can free a slot in the Queue.
  wsSched: `That day already has 20 posts, which is this workspace's daily limit. Cancel or move another post on that day, then approve again, or reject this one and ask the member to submit it for another day.`,
  ownNow: `This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. ${nowSteps(RESET)}`,
  ownSched: `That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). ${SCHEDULED_STEPS}`,
  ownNamedNow: `Sam, an owner of this workspace, has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. ${nowSteps(RESET)}`,
  ownNamedSched: `Sam, an owner of this workspace, already has 15 posts that day across the workspaces they own, which is the daily limit for one person (retries count toward it). ${SCHEDULED_STEPS}`,
  svcNow: `Vibe Socials has reached its daily limit of posts for the whole service. ${nowSteps(RESET)}`,
  svcSched: `That day is full: Vibe Socials has reached its daily limit of posts for the whole service. ${SCHEDULED_STEPS}`,
  poolNow: `Vibe Socials has reached today's limit of 5 posts shared by accounts made today (UTC) or with an unconfirmed email address. ${nowSteps(RESET)} ${NOTE}`,
  poolSched: `That day is full: Vibe Socials has reached the limit of 5 posts a day shared by accounts made today (UTC) or with an unconfirmed email address. ${SCHEDULED_STEPS} ${NOTE}`,
};

describe("each builder's approval form: the same facts, the approver's steps", () => {
  it("workspace, scheduled and now", () => {
    expect(dailyPostLimitMessage(20, "now", time, "approval")).toBe(approval.wsNow);
    expect(dailyPostLimitMessage(20, "schedule", time, "approval")).toBe(approval.wsSched);
  });
  it("per person, unnamed and named, scheduled and now", () => {
    expect(ownerDailyPostLimitMessage(15, "now", null, null, time, {}, "approval")).toBe(approval.ownNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, null, time, {}, "approval")).toBe(approval.ownSched);
    expect(ownerDailyPostLimitMessage(15, "now", null, holder, time, {}, "approval")).toBe(approval.ownNamedNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {}, "approval")).toBe(approval.ownNamedSched);
  });
  it("service-wide and new-account, scheduled and now", () => {
    expect(serviceDailyPostLimitMessage("now", time, "approval")).toBe(approval.svcNow);
    expect(serviceDailyPostLimitMessage("schedule", time, "approval")).toBe(approval.svcSched);
    expect(newAccountPoolMessage("now", time, "approval")).toBe(approval.poolNow);
    expect(newAccountPoolMessage("schedule", time, "approval")).toBe(approval.poolSched);
  });
  it("only the workspace's own limit names cancelling or moving a post", () => {
    for (const [key, text] of Object.entries(approval)) {
      expect(/Cancel or move/.test(text)).toBe(key === "wsSched");
    }
  });
  it("a reset in the reader's zone is kept whole", () => {
    const zoned = { now: time.now, timeZone: "America/New_York" };
    const reset = dailyPostLimitMessage(20, "now", zoned).match(/try again (from .*)\.$/)![1]!;
    expect(dailyPostLimitMessage(20, "now", zoned, "approval")).toContain(nowSteps(reset));
  });
  it("no pick-another-day wording is left, and nothing the approver can't do is offered", () => {
    for (const text of Object.values(approval)) {
      expect(text).not.toMatch(/Pick another day|Schedule this post|try again/);
    }
  });
  it("word counts, notes included: only the per-person and new-account sentences pass about 45", () => {
    const counts = Object.fromEntries(Object.entries(approval).map(([k, v]) => [k, v.split(/\s+/).length]));
    expect(counts).toEqual({
      wsNow: 30, wsSched: 37, ownNow: 42, ownSched: 47, ownNamedNow: 45, ownNamedSched: 50,
      svcNow: 32, svcSched: 38, poolNow: 60, poolSched: 68,
    });
  });
});

// R56 publishing-flow L1: for a slot later today the count only goes up (the
// pools count runs already gone out; the workspace's count includes posts
// already published or failed), so "once that day has room" never comes true.
// The caller says the counted day is today; the approver then reads when to
// approve again, and that the post would then go out at once.
const todaySteps = (reset: string) =>
  `Approve it again ${reset}; it then publishes at once. Or reject it and ask the member to schedule it for another day.`;
// R57 pages-a L2 / publishing-flow L2: the workspace's and the per-person counts
// also hold posts still scheduled later today, so cancelling or moving one of
// those frees room at once; only the pools count runs already gone out.
const freeableTodaySteps = (reset: string) =>
  `Cancel or move another post still scheduled for today, then approve again. Or approve it again ${reset}, when it publishes at once, or reject it and ask the member to schedule it for another day.`;
const today = {
  wsSched: `That day already has 20 posts, which is this workspace's daily limit. ${freeableTodaySteps(RESET)}`,
  ownSched: `That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). ${freeableTodaySteps(RESET)}`,
  ownNamedSched: `Sam, an owner of this workspace, already has 15 posts that day across the workspaces they own, which is the daily limit for one person (retries count toward it). ${freeableTodaySteps(RESET)}`,
  svcSched: `That day is full: Vibe Socials has reached its daily limit of posts for the whole service. ${todaySteps(RESET)}`,
  poolSched: `That day is full: Vibe Socials has reached the limit of 5 posts a day shared by accounts made today (UTC) or with an unconfirmed email address. ${todaySteps(RESET)} ${NOTE}`,
};

describe("an approval for a slot later today: a slot to free where one can be freed, else the reset ending", () => {
  it("workspace", () => {
    expect(dailyPostLimitMessage(20, "schedule", time, "approval", true)).toBe(today.wsSched);
  });
  it("per person, unnamed and named", () => {
    expect(ownerDailyPostLimitMessage(15, "schedule", null, null, time, {}, "approval", true)).toBe(today.ownSched);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {}, "approval", true)).toBe(today.ownNamedSched);
  });
  it("service-wide and new-account pool", () => {
    expect(serviceDailyPostLimitMessage("schedule", time, "approval", true)).toBe(today.svcSched);
    expect(newAccountPoolMessage("schedule", time, "approval", true)).toBe(today.poolSched);
  });
  it("another day keeps the current endings", () => {
    expect(dailyPostLimitMessage(20, "schedule", time, "approval", false)).toBe(approval.wsSched);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, null, time, {}, "approval", false)).toBe(approval.ownSched);
    expect(serviceDailyPostLimitMessage("schedule", time, "approval", false)).toBe(approval.svcSched);
    expect(newAccountPoolMessage("schedule", time, "approval", false)).toBe(approval.poolSched);
  });
  it("the default sentences and the now forms are byte-identical, today or not", () => {
    expect(dailyPostLimitMessage(20, "schedule", time, "default", true)).toBe(original.wsSched);
    expect(dailyPostLimitMessage(20, "now", time, "default", true)).toBe(original.wsNow);
    expect(dailyPostLimitMessage(20, "now", time, "approval", true)).toBe(approval.wsNow);
    expect(ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {}, "default", true)).toBe(original.ownNamedSched);
    expect(ownerDailyPostLimitMessage(15, "now", null, null, time, {}, "approval", true)).toBe(approval.ownNow);
    expect(serviceDailyPostLimitMessage("schedule", time, "default", true)).toBe(original.svcSched);
    expect(serviceDailyPostLimitMessage("now", time, "approval", true)).toBe(approval.svcNow);
    expect(newAccountPoolMessage("schedule", time, "default", true)).toBe(original.poolSched);
    expect(newAccountPoolMessage("now", time, "approval", true)).toBe(approval.poolNow);
  });
  it("a reset in the reader's zone is kept whole", () => {
    const zoned = { now: time.now, timeZone: "America/New_York" };
    const reset = dailyPostLimitMessage(20, "now", zoned).match(/try again (from .*)\.$/)![1]!;
    expect(serviceDailyPostLimitMessage("schedule", zoned, "approval", true)).toContain(todaySteps(reset));
    expect(dailyPostLimitMessage(20, "schedule", zoned, "approval", true)).toContain(freeableTodaySteps(reset));
  });
  it("only the two pools leave out the free-a-slot step today", () => {
    const built = {
      wsSched: dailyPostLimitMessage(20, "schedule", time, "approval", true),
      ownSched: ownerDailyPostLimitMessage(15, "schedule", null, null, time, {}, "approval", true),
      ownNamedSched: ownerDailyPostLimitMessage(15, "schedule", null, holder, time, {}, "approval", true),
      svcSched: serviceDailyPostLimitMessage("schedule", time, "approval", true),
      poolSched: newAccountPoolMessage("schedule", time, "approval", true),
    };
    for (const [key, text] of Object.entries(built)) {
      const pool = key === "svcSched" || key === "poolSched";
      expect(text.includes("Cancel or move another post still scheduled for today, then approve again.")).toBe(!pool);
      expect(text.includes("it then publishes at once")).toBe(pool);
    }
  });
});
