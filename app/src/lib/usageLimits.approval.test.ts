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
