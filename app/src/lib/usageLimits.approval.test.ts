import { describe, expect, it } from "vitest";

import {
  approvalLimitMessage,
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

const SCHEDULED_STEPS =
  "Cancel or move another post on that day, then approve again. Or reject this one and ask the member to submit it for another day.";
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

describe("approvalLimitMessage", () => {
  it("workspace limit, scheduled: the approval steps", () => {
    expect(approvalLimitMessage(original.wsSched)).toBe(
      `That day already has 20 posts, which is this workspace's daily limit. ${SCHEDULED_STEPS}`,
    );
  });
  it("workspace limit, now: the approval steps with the reset time", () => {
    expect(approvalLimitMessage(original.wsNow)).toBe(
      `This workspace has reached its limit of 20 posts for today. ${nowSteps("in 9 hours")}`,
    );
  });
  it("per-person limit, named and unnamed, scheduled and now", () => {
    expect(approvalLimitMessage(original.ownSched)).toBe(original.ownSched.replace("Pick another day.", SCHEDULED_STEPS));
    expect(approvalLimitMessage(original.ownNamedSched)).toBe(
      original.ownNamedSched.replace("Pick another day.", SCHEDULED_STEPS),
    );
    expect(approvalLimitMessage(original.ownNow)).toBe(
      original.ownNow.replace("Schedule this post for another day, or try again in 9 hours.", nowSteps("in 9 hours")),
    );
    expect(approvalLimitMessage(original.ownNamedNow)).toContain(nowSteps("in 9 hours"));
    expect(approvalLimitMessage(original.ownNamedNow)).toMatch(/^Sam, an owner of this workspace, has reached/);
  });
  it("service and pool sentences keep their trailing note", () => {
    expect(approvalLimitMessage(original.svcSched)).toBe(original.svcSched.replace("Pick another day.", SCHEDULED_STEPS));
    expect(approvalLimitMessage(original.poolNow)).toContain(`${nowSteps("in 9 hours")} It stops applying`);
    expect(approvalLimitMessage(original.poolSched)).toContain(`${SCHEDULED_STEPS} It stops applying`);
  });
  it("a reset in the reader's zone is kept whole", () => {
    const zoned = dailyPostLimitMessage(20, "now", { now: time.now, timeZone: "America/New_York" });
    expect(approvalLimitMessage(zoned)).toContain(nowSteps(zoned.match(/try again (from .*)\.$/)![1]!));
  });
  it("no pick-another-day wording is left, and a sentence without it passes through", () => {
    for (const text of Object.values(original)) {
      expect(approvalLimitMessage(text)).not.toMatch(/Pick another day|Schedule this post for another day/);
    }
    expect(approvalLimitMessage("We couldn't check today's limits. Try again in a minute.")).toBe(
      "We couldn't check today's limits. Try again in a minute.",
    );
  });
});
