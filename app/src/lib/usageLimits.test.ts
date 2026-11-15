import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_LIMITS,
  dailyPostLimitMessage,
  formatStorageGb,
  NEW_ACCOUNT_DAILY_POST_LIMIT,
  OWNER_DAILY_POST_LIMIT,
  ownerDailyPostLimit,
  ownerDailyPostLimitMessage,
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
  it("holds the numbers, sized so the owner's own agency use fits", () => {
    expect(SERVICE_DAILY_POST_LIMIT).toBe(40);
    expect(OWNER_DAILY_POST_LIMIT).toBe(30);
    expect(NEW_ACCOUNT_DAILY_POST_LIMIT).toBe(5);
    expect(RETRIES_PER_POST_PER_DAY).toBe(3);
    expect(WORKSPACES_CREATED_LIMIT).toBe(30);
    expect(WORKSPACES_CREATED_WINDOW_DAYS).toBe(30);
    // An agency on its trial: several client workspaces at a few posts a day each (7 x 4) fits.
    expect(7 * 4).toBeLessThan(OWNER_DAILY_POST_LIMIT);
    expect(OWNER_DAILY_POST_LIMIT).toBeLessThan(SERVICE_DAILY_POST_LIMIT);
    expect(NEW_ACCOUNT_DAILY_POST_LIMIT).toBeLessThan(OWNER_DAILY_POST_LIMIT);
  });

  // R6-security M2 / new-customer L8: the free cap is sized next to what is
  // spent already (CLAUDE.md: about 28,000 of the 50,000 a month, idle work
  // and the operator's own posting) and the paying workspaces' expected posts.
  it("keeps a month at the free cap, the operator's use and the expected paid posts inside 50,000 executions", () => {
    const alreadyUsed = 28_000;
    const paidPostsPerDay = 15; // e.g. five paying workspaces at 3 a day
    const perPost = 10; // about 6 plus 1 per platform, at 4 platforms
    const month = alreadyUsed + (SERVICE_DAILY_POST_LIMIT + paidPostsPerDay) * perPost * 31;
    expect(month).toBe(45_050);
    // At least 10% left for Reels, posts to more platforms and retries of paid posts.
    expect(50_000 - month).toBeGreaterThanOrEqual(4_900);
    // Even with every free and paid post at 6 platforms (12 each), the month stays inside.
    expect(alreadyUsed + (SERVICE_DAILY_POST_LIMIT + paidPostsPerDay) * 12 * 31).toBeLessThan(50_000);
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
    expect(ownerDailyPostLimit({ emailVerifiedAt: old, createdAt: old }, now)).toEqual({ limit: 30, reduced: false });
    expect(ownerDailyPostLimit({ emailVerifiedAt: null, createdAt: old }, now)).toEqual({ limit: 5, reduced: true });
    const lessThanADay = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    expect(ownerDailyPostLimit({ emailVerifiedAt: now, createdAt: lessThanADay }, now)).toEqual({ limit: 5, reduced: true });
    const aDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(ownerDailyPostLimit({ emailVerifiedAt: now, createdAt: aDay }, now)).toEqual({ limit: 30, reduced: false });
  });

  it("the per-person daily post sentences", () => {
    expect(ownerDailyPostLimitMessage(30, "now")).toBe(
      "This workspace's owner has reached the limit of 30 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
    );
    expect(ownerDailyPostLimitMessage(30, "schedule")).toBe(
      "That day already has 30 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person. Pick another day.",
    );
    expect(ownerDailyPostLimitMessage(30, "retry")).toBe(
      "This workspace's owner has reached the limit of 30 posts a day across all the workspaces they own, and retries count toward it. Retry tomorrow.",
    );
    expect(ownerDailyPostLimitMessage(5, "now", true)).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow. The limit is 30 once the owner has confirmed their email address and the account is a day old.",
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

  it("the per-post retry sentence", () => {
    expect(postRetryLimitMessage(3)).toBe(
      "This post has been retried 3 times today, the most for one day. Retry it again tomorrow.",
    );
  });

  it("the workspace creation sentence names the day it opens again", () => {
    expect(workspaceCreationLimitMessage(30, new Date("2026-12-03T09:00:00Z"))).toBe(
      "You have created 30 workspaces in the last 30 days, the most allowed. Deleted workspaces count too. You can create another from 3 December 2026.",
    );
  });
});
