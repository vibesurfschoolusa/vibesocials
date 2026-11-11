import { describe, expect, it } from "vitest";

import { PLANS } from "./plans";
import { resolveWorkspaceLimits } from "./usageLimits";

/**
 * 21a: the limit resolver with plans. Order: the workspace's override column,
 * then (billing on, a plan or a trial) the plan's limit, then the environment,
 * then the built-in default. Exempt workspaces and billing off resolve as before.
 */

const MB = 1024 * 1024;
const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ON = { BILLING_ENABLED: "true" };
const ENV_LIMITS = {
  LIMIT_POSTS_PER_DAY: "7",
  LIMIT_X_POSTS_PER_MONTH: "8",
  LIMIT_YOUTUBE_UPLOADS_PER_DAY: "9",
  LIMIT_STORAGE_MB: "100",
};
const NO_OVERRIDES = {
  limitPostsPerDay: null,
  limitXPostsPerMonth: null,
  limitYoutubeUploadsPerDay: null,
  limitStorageMb: null,
};

function asLimits(plan: keyof typeof PLANS) {
  const limits = PLANS[plan].limits;
  return {
    postsPerDay: limits.postsPerDay,
    xPostsPerMonth: limits.xPostsPerMonth,
    youtubeUploadsPerDay: limits.youtubeUploadsPerDay,
    storageBytes: limits.storageMb * MB,
  };
}

describe("with billing off", () => {
  it("resolves exactly as before for any combination of the plan columns", () => {
    const overrideSets = [
      {},
      NO_OVERRIDES,
      { limitPostsPerDay: 3, limitXPostsPerMonth: null, limitYoutubeUploadsPerDay: 0, limitStorageMb: 10 },
    ];
    for (const env of [{}, ENV_LIMITS, { ...ENV_LIMITS, BILLING_ENABLED: "TRUE" }]) {
      for (const overrides of overrideSets) {
        const today = resolveWorkspaceLimits(overrides, env);
        for (const billingExempt of [undefined, false, true]) {
          for (const plan of [undefined, null, "starter", "pro", "unknown"]) {
            for (const planStatus of [null, "active", "canceled"]) {
              for (const trialEndsAt of [null, new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - DAY)]) {
                const row = { ...overrides, billingExempt, plan, planStatus, trialEndsAt };
                expect(resolveWorkspaceLimits(row, env, NOW)).toEqual(today);
              }
            }
          }
        }
      }
    }
  });
});

describe("with billing on", () => {
  it("takes the plan's limits over the environment and the defaults", () => {
    const row = { ...NO_OVERRIDES, billingExempt: false, plan: "growth", planStatus: "active" };
    expect(resolveWorkspaceLimits(row, { ...ON, ...ENV_LIMITS }, NOW)).toEqual(asLimits("growth"));
    expect(resolveWorkspaceLimits({ ...row, plan: "pro" }, ON, NOW)).toEqual(asLimits("pro"));
  });

  it("a workspace in trial uses the starter limits", () => {
    const row = { ...NO_OVERRIDES, billingExempt: false, trialEndsAt: new Date(NOW.getTime() + DAY) };
    expect(resolveWorkspaceLimits(row, { ...ON, ...ENV_LIMITS }, NOW)).toEqual(asLimits("starter"));
  });

  it("the operator's override still wins over the plan", () => {
    const row = {
      ...NO_OVERRIDES,
      limitPostsPerDay: 2,
      limitStorageMb: 1,
      billingExempt: false,
      plan: "pro",
      planStatus: "active",
    };
    expect(resolveWorkspaceLimits(row, ON, NOW)).toEqual({ ...asLimits("pro"), postsPerDay: 2, storageBytes: MB });
  });

  it("an exempt workspace, or one with no plan and no trial (created with billing off), resolves as before", () => {
    for (const row of [
      { ...NO_OVERRIDES, billingExempt: true, plan: "pro", planStatus: "active" },
      { ...NO_OVERRIDES, billingExempt: false, plan: null, trialEndsAt: null },
    ]) {
      expect(resolveWorkspaceLimits(row, { ...ON, ...ENV_LIMITS }, NOW)).toEqual(resolveWorkspaceLimits({}, ENV_LIMITS));
    }
  });

  it("a plan the code does not know, or a trial that ended, falls back to the environment", () => {
    const unknownPlan = { ...NO_OVERRIDES, billingExempt: false, plan: "enterprise", planStatus: "active" };
    expect(resolveWorkspaceLimits(unknownPlan, { ...ON, ...ENV_LIMITS }, NOW)).toEqual(resolveWorkspaceLimits({}, ENV_LIMITS));
    const ended = { ...NO_OVERRIDES, billingExempt: false, trialEndsAt: new Date(NOW.getTime() - DAY) };
    expect(resolveWorkspaceLimits(ended, { ...ON, ...ENV_LIMITS }, NOW)).toEqual(resolveWorkspaceLimits({}, ENV_LIMITS));
  });
});
