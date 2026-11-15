import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_LIMITS,
  dailyPostLimitMessage,
  formatStorageGb,
  GUARANTEED_RUNS_PER_PERSON,
  NEW_ACCOUNT_DAILY_POST_LIMIT,
  NEW_ACCOUNT_POOL_DAILY_LIMIT,
  newAccountPoolAtSendMessage,
  newAccountPoolMessage,
  OWNER_DAILY_POST_LIMIT,
  ownerDailyPostLimit,
  ownerDailyPostLimitMessage,
  ownerDailySendLimitMessage,
  pacificDayRange,
  personalPostLimitApplies,
  postRetryLimitMessage,
  RETRIES_PER_POST_PER_DAY,
  SERVICE_DAILY_POST_LIMIT,
  serviceDailyPostLimitAtSendMessage,
  serviceDailyPostLimitMessage,
  WORKSPACES_CREATED_LIMIT,
  WORKSPACES_CREATED_WINDOW_DAYS,
  workspaceCreationLimitMessage,
  resolveWorkspaceLimits,
  storageFullMessage,
  usageResetText,
  utcDayKey,
  utcDayRange,
  utcMonthRange,
  xMonthlyLimitMessage,
  youtubeWorkspaceDailyLimitMessage,
} from "./usageLimits";

const MB = 1024 * 1024;

describe("DEFAULT_WORKSPACE_LIMITS", () => {
  it("holds the built-in numbers", () => {
    expect(DEFAULT_WORKSPACE_LIMITS).toEqual({
      postsPerDay: 20,
      xPostsPerMonth: 30,
      youtubeUploadsPerDay: 10,
      storageBytes: 5120 * MB,
    });
  });
});

describe("resolveWorkspaceLimits", () => {
  const noOverrides = {
    limitPostsPerDay: null,
    limitXPostsPerMonth: null,
    limitYoutubeUploadsPerDay: null,
    limitStorageMb: null,
  };

  it("uses the built-in defaults with no column and no environment", () => {
    expect(resolveWorkspaceLimits(noOverrides, {})).toEqual(DEFAULT_WORKSPACE_LIMITS);
  });

  it("uses a whole non-negative environment value over the built-in", () => {
    expect(
      resolveWorkspaceLimits(noOverrides, {
        LIMIT_POSTS_PER_DAY: "50",
        LIMIT_X_POSTS_PER_MONTH: " 100 ",
        LIMIT_YOUTUBE_UPLOADS_PER_DAY: "3",
        LIMIT_STORAGE_MB: "512",
      }),
    ).toEqual({ postsPerDay: 50, xPostsPerMonth: 100, youtubeUploadsPerDay: 3, storageBytes: 512 * MB });
  });

  it("lets the workspace column beat the environment", () => {
    expect(
      resolveWorkspaceLimits(
        { limitPostsPerDay: 7, limitXPostsPerMonth: 8, limitYoutubeUploadsPerDay: 9, limitStorageMb: 10 },
        {
          LIMIT_POSTS_PER_DAY: "50",
          LIMIT_X_POSTS_PER_MONTH: "100",
          LIMIT_YOUTUBE_UPLOADS_PER_DAY: "3",
          LIMIT_STORAGE_MB: "512",
        },
      ),
    ).toEqual({ postsPerDay: 7, xPostsPerMonth: 8, youtubeUploadsPerDay: 9, storageBytes: 10 * MB });
  });

  it("honours zero from the column and from the environment", () => {
    expect(
      resolveWorkspaceLimits(
        { ...noOverrides, limitPostsPerDay: 0, limitStorageMb: 0 },
        { LIMIT_X_POSTS_PER_MONTH: "0", LIMIT_YOUTUBE_UPLOADS_PER_DAY: "0" },
      ),
    ).toEqual({ postsPerDay: 0, xPostsPerMonth: 0, youtubeUploadsPerDay: 0, storageBytes: 0 });
  });

  it.each(["", "abc", "-1", "1.5", "1e3", "99999999999999999999"])(
    "falls back to the built-in for the bad environment value %j",
    (raw) => {
      expect(resolveWorkspaceLimits(noOverrides, { LIMIT_POSTS_PER_DAY: raw }).postsPerDay).toBe(20);
    },
  );

  it("accepts missing override fields as null", () => {
    expect(resolveWorkspaceLimits({}, {})).toEqual(DEFAULT_WORKSPACE_LIMITS);
  });
});

describe("utcDayRange", () => {
  it("puts 23:59:59 UTC in its own day", () => {
    const { start, end } = utcDayRange(new Date("2026-11-10T23:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("starts a new day at 00:00:00 UTC", () => {
    const { start, end } = utcDayRange(new Date("2026-11-11T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-12T00:00:00.000Z");
  });

  it("rolls the last day of a month into the next month", () => {
    expect(utcDayRange(new Date("2026-11-30T12:00:00Z")).end.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(utcDayRange(new Date("2026-12-31T23:59:59Z")).end.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("names the day as YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-11-10T23:59:59Z"))).toBe("2026-11-10");
    expect(utcDayKey(new Date("2026-11-11T00:00:00Z"))).toBe("2026-11-11");
  });
});

describe("utcMonthRange", () => {
  it("spans the whole UTC month, the last second included", () => {
    const { start, end } = utcMonthRange(new Date("2026-11-30T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("starts the new month at 00:00:00 UTC on the 1st", () => {
    expect(utcMonthRange(new Date("2026-12-01T00:00:00Z")).start.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  it("rolls December into January of the next year", () => {
    const { start, end } = utcMonthRange(new Date("2026-12-31T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("pacificDayRange", () => {
  it("is 25 hours long on the day daylight saving time ends (2026-11-01)", () => {
    const { start, end } = pacificDayRange(new Date("2026-11-01T20:00:00Z"));
    expect(start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("is 23 hours long on the day daylight saving time starts (2026-03-08)", () => {
    const { start, end } = pacificDayRange(new Date("2026-03-08T20:00:00Z"));
    expect(start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("puts 07:59 UTC in winter in the previous Pacific day", () => {
    const { start } = pacificDayRange(new Date("2026-11-10T07:59:59Z"));
    expect(start.toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });
});

describe("sentences", () => {
  it("daily post limit, publishing now", () => {
    expect(dailyPostLimitMessage(20, "now")).toBe(
      "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.",
    );
  });

  it("daily post limit, scheduling or moving", () => {
    expect(dailyPostLimitMessage(20, "schedule")).toBe(
      "That day already has 20 posts, which is this workspace's daily limit. Pick another day.",
    );
  });

  it("X monthly limit names this month and the next", () => {
    expect(xMonthlyLimitMessage(30, new Date("2026-11-10T12:00:00Z"))).toBe(
      "This X account has used its 30 X posts for November, counted across every workspace it posts from. X posts start again on 1 December.",
    );
  });

  it("X monthly limit in December names January", () => {
    expect(xMonthlyLimitMessage(30, new Date("2026-12-31T23:59:59Z"))).toBe(
      "This X account has used its 30 X posts for December, counted across every workspace it posts from. X posts start again on 1 January.",
    );
  });

  it("X monthly limit uses the UTC month, not the local one", () => {
    expect(xMonthlyLimitMessage(5, new Date("2026-12-01T00:00:00Z"))).toBe(
      "This X account has used its 5 X posts for December, counted across every workspace it posts from. X posts start again on 1 January.",
    );
  });

  it("YouTube workspace daily limit", () => {
    expect(youtubeWorkspaceDailyLimitMessage(10)).toBe(
      "This workspace has reached its limit of 10 YouTube uploads for today. Retry this upload tomorrow.",
    );
  });

  it("storage full, in GB with one decimal", () => {
    expect(storageFullMessage(5120 * MB)).toBe(
      "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.",
    );
    expect(storageFullMessage(1536 * MB)).toBe(
      "This workspace's media storage is full (1.5 GB). Delete media you no longer need on the Media page, then upload again.",
    );
  });

  it("says when each limit starts again", () => {
    expect(usageResetText("postsPerDay", new Date("2026-11-11T00:00:00Z"))).toBe(
      "Starts again at 00:00 UTC on 11 November.",
    );
    expect(usageResetText("xPostsPerMonth", new Date("2027-01-01T00:00:00Z"))).toBe(
      "Starts again on 1 January.",
    );
    expect(usageResetText("youtubeUploadsPerDay", new Date("2026-11-11T08:00:00Z"))).toBe(
      "Starts again at midnight Pacific time.",
    );
    expect(usageResetText("storage", null)).toBe("Frees up when media is deleted on the Media page.");
  });

  it("formats bytes as GB with one decimal", () => {
    expect(formatStorageGb(0)).toBe("0.0 GB");
    expect(formatStorageGb(300 * MB)).toBe("0.3 GB");
  });
});

// S1 fix round 1: "its limit of 1 YouTube uploads" read wrong with the plans' small numbers.
describe("limit messages agree with their number", () => {
  it.each([
    [1, "post"],
    [2, "posts"],
    [10, "posts"],
  ])("daily posts: %i %s", (n, word) => {
    expect(dailyPostLimitMessage(n, "now")).toBe(
      `This workspace has reached its limit of ${n} ${word} for today. Schedule this post for another day, or try again tomorrow.`,
    );
    expect(dailyPostLimitMessage(n, "schedule")).toBe(
      `That day already has ${n} ${word}, which is this workspace's daily limit. Pick another day.`,
    );
  });

  it.each([
    [1, "X post"],
    [2, "X posts"],
    [10, "X posts"],
  ])("X posts: %i %s", (n, words) => {
    expect(xMonthlyLimitMessage(n, new Date("2026-11-10T12:00:00Z"))).toBe(
      `This X account has used its ${n} ${words} for November, counted across every workspace it posts from. X posts start again on 1 December.`,
    );
  });

  it.each([
    [1, "YouTube upload"],
    [2, "YouTube uploads"],
    [10, "YouTube uploads"],
  ])("YouTube uploads: %i %s", (n, words) => {
    expect(youtubeWorkspaceDailyLimitMessage(n)).toBe(
      `This workspace has reached its limit of ${n} ${words} for today. Retry this upload tomorrow.`,
    );
  });
});

// R5-security M1: the limits that do not multiply with workspaces.
describe("limits across workspaces", () => {
  // R7-security M1: two pools and a share of the main one nobody else can take.
  it("holds the numbers", () => {
    expect(SERVICE_DAILY_POST_LIMIT).toBe(30);
    expect(NEW_ACCOUNT_POOL_DAILY_LIMIT).toBe(10);
    expect(GUARANTEED_RUNS_PER_PERSON).toBe(3);
    expect(OWNER_DAILY_POST_LIMIT).toBe(15);
    expect(NEW_ACCOUNT_DAILY_POST_LIMIT).toBe(5);
    expect(RETRIES_PER_POST_PER_DAY).toBe(3);
    expect(WORKSPACES_CREATED_LIMIT).toBe(30);
    expect(WORKSPACES_CREATED_WINDOW_DAYS).toBe(30);
    // One confirmed person takes at most half the main pool; a new account half the small one.
    expect(OWNER_DAILY_POST_LIMIT * 2).toBe(SERVICE_DAILY_POST_LIMIT);
    expect(NEW_ACCOUNT_DAILY_POST_LIMIT * 2).toBe(NEW_ACCOUNT_POOL_DAILY_LIMIT);
    expect(GUARANTEED_RUNS_PER_PERSON).toBeLessThan(OWNER_DAILY_POST_LIMIT);
  });

  // R7-security M1: the pools are sized against what is left of the Inngest
  // Hobby plan this month (the coordinator's reading on 14 Nov 2026) and the
  // idle load counted from the functions' schedules.
  it("keeps idle work plus a full day of free runs inside what is left of the month", () => {
    const monthly = 50_000;
    const usedBy14Nov = 33_687;
    const daysLeft = 16; // 15 to 30 November
    const perDay = Math.floor((monthly - usedBy14Nov) / daysLeft);
    expect(perDay).toBe(1_019);

    // Idle executions a day, one per step of each scheduled run with nothing to do:
    const idle =
      144 * 1 + // scheduled-post scanner, every 10 minutes: claim
      24 * 2 + // media retention, hourly: one sweep batch, drain
      24 * 1 + // YouTube numbers, hourly: one page
      24 * 2 + // stale post sweep, hourly: fail stale, heal
      7 + // connection health, daily: start, page, fan-out, purge, LinkedIn, Google, notices
      10 + // the token refreshes it fans out (about 10 connections near expiry)
      2 + 3 + 1 + 1 + 1 + 1; // problem digest, review alerts, listing and social numbers, billing, orphan sweep
    expect(idle).toBe(290);

    // A run is about 6 executions plus 1 per platform: 12 at 6 platforms.
    const freeRunsAtCap = (SERVICE_DAILY_POST_LIMIT + NEW_ACCOUNT_POOL_DAILY_LIMIT) * 12;
    expect(freeRunsAtCap).toBe(480);
    expect(300 + freeRunsAtCap).toBe(780);
    // About 239 a day left for paying workspaces, the operator and the guaranteed runs past a full pool.
    expect(perDay - (300 + freeRunsAtCap)).toBeGreaterThanOrEqual(230);
  });

  it("the per-person posts apply with billing off, and with it on to every workspace not on a running plan", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const off = {};
    const on = { BILLING_ENABLED: "true" };
    const trial = { billingExempt: false, trialEndsAt: new Date("2026-11-20T00:00:00Z") };
    const paid = { billingExempt: false, plan: "starter", planStatus: "active", currentPeriodEnd: new Date("2026-12-14T00:00:00Z") };
    expect(personalPostLimitApplies(paid, off, now)).toBe(true);
    expect(personalPostLimitApplies({ billingExempt: true }, off, now)).toBe(true);
    expect(personalPostLimitApplies(trial, on, now)).toBe(true);
    expect(personalPostLimitApplies(paid, on, now)).toBe(false);
    expect(personalPostLimitApplies({ billingExempt: true }, on, now)).toBe(false);
    // R6-new-customer M1: made while billing was off (no plan, no trial) and
    // counted by the service's cap, so the per-person total counts it too.
    expect(personalPostLimitApplies({ billingExempt: false }, on, now)).toBe(true);
    expect(personalPostLimitApplies({ billingExempt: false, trialEndsAt: new Date("2026-11-01T00:00:00Z") }, on, now)).toBe(true);
  });

  // R6-security M2: throwaway accounts get a much smaller share.
  it("a lower per-person number until the email is confirmed and the account is a day old", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const old = new Date("2026-11-01T00:00:00Z");
    expect(ownerDailyPostLimit({ emailVerifiedAt: old, createdAt: old }, now)).toEqual({ limit: 15, reduced: false });
    expect(ownerDailyPostLimit({ emailVerifiedAt: null, createdAt: old }, now)).toEqual({ limit: 5, reduced: true });
    const lessThanADay = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    expect(ownerDailyPostLimit({ emailVerifiedAt: now, createdAt: lessThanADay }, now)).toEqual({ limit: 5, reduced: true });
    const aDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(ownerDailyPostLimit({ emailVerifiedAt: now, createdAt: aDay }, now)).toEqual({ limit: 15, reduced: false });
  });

  it("the per-person daily post sentences", () => {
    expect(ownerDailyPostLimitMessage(15, "now")).toBe(
      "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
    );
    expect(ownerDailyPostLimitMessage(15, "schedule")).toBe(
      "That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person. Pick another day.",
    );
    // R7-security L1: a retry is a run like a post.
    expect(ownerDailySendLimitMessage(15)).toBe(
      "This workspace's owner has reached the limit of 15 posts a day across the workspaces they own, and retries count toward it. Retry tomorrow, or schedule the post again for another day.",
    );
    expect(ownerDailySendLimitMessage(5, true)).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across the workspaces they own, and retries count toward it. Retry tomorrow, or schedule the post again for another day. The limit is 15 once the owner has confirmed their email address and the account is a day old.",
    );
    expect(ownerDailyPostLimitMessage(5, "now", true)).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow. The limit is 15 once the owner has confirmed their email address and the account is a day old.",
    );
  });

  // R7-security M1: the small pool's own sentences say who shares it and how to leave it.
  it("the new-account pool's sentences", () => {
    const leave = "It stops applying once the owner has confirmed their email address and the account is a day old.";
    expect(newAccountPoolMessage("now")).toBe(
      `Vibe Socials has reached today's limit of 10 posts shared by accounts under a day old or with an unconfirmed email address. Schedule this post for another day, or try again tomorrow. ${leave}`,
    );
    expect(newAccountPoolMessage("schedule")).toBe(
      `That day is full: Vibe Socials has reached the limit of 10 posts a day shared by accounts under a day old or with an unconfirmed email address. Pick another day. ${leave}`,
    );
    expect(newAccountPoolMessage("retry")).toBe(
      `Vibe Socials has reached today's limit of 10 posts shared by accounts under a day old or with an unconfirmed email address, and retries count toward it. Retry tomorrow. ${leave}`,
    );
    expect(newAccountPoolAtSendMessage()).toBe(
      `Not sent: Vibe Socials had reached the day's limit of 10 posts shared by accounts under a day old or with an unconfirmed email address when this post was due. Retry it tomorrow, or schedule it again. ${leave}`,
    );
  });

  it("the service's daily post sentences say the service's limit was reached", () => {
    expect(serviceDailyPostLimitMessage("now")).toBe(
      "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
    );
    expect(serviceDailyPostLimitMessage("schedule")).toBe(
      "That day is full: Vibe Socials has reached its daily limit of posts for the whole service. Pick another day.",
    );
    expect(serviceDailyPostLimitMessage("retry")).toBe(
      "Vibe Socials has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.",
    );
    expect(serviceDailyPostLimitAtSendMessage()).toBe(
      "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.",
    );
  });

  // R7-security L1: retries are counted per post, all platforms together, and Retry all failed is one.
  it("the retry sentence points to Retry all failed", () => {
    expect(postRetryLimitMessage(3)).toBe(
      "This post has been retried 3 times today, the most for one day. Try again tomorrow. Retry all failed retries every failed platform of a post at once and counts as one retry.",
    );
  });

  it("the workspace creation sentence names the day it opens again", () => {
    expect(workspaceCreationLimitMessage(30, new Date("2026-12-03T09:00:00Z"))).toBe(
      "You have created 30 workspaces in the last 30 days, the most allowed. Deleted workspaces count too. You can create another from 3 December 2026.",
    );
  });
});
