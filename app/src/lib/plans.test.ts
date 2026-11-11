import { describe, expect, it } from "vitest";

import { isPlanKey, PLAN_KEYS, PLANS } from "./plans";
import { DEFAULT_WORKSPACE_LIMITS } from "./usageLimits";

const MB = 1024 * 1024;

describe("PLANS", () => {
  it("has the three plans, each with a name and four limits", () => {
    expect(PLAN_KEYS).toEqual(["starter", "growth", "pro"]);
    expect(PLANS.starter.name).toBe("Starter");
    expect(PLANS.growth.name).toBe("Growth");
    expect(PLANS.pro.name).toBe("Pro");
  });

  it("starter is today's defaults, growth twice them, pro five times", () => {
    const today = {
      postsPerDay: DEFAULT_WORKSPACE_LIMITS.postsPerDay,
      xPostsPerMonth: DEFAULT_WORKSPACE_LIMITS.xPostsPerMonth,
      youtubeUploadsPerDay: DEFAULT_WORKSPACE_LIMITS.youtubeUploadsPerDay,
      storageMb: DEFAULT_WORKSPACE_LIMITS.storageBytes / MB,
    };
    const times = (n: number) =>
      Object.fromEntries(Object.entries(today).map(([key, value]) => [key, value * n]));
    expect(PLANS.starter.limits).toEqual(today);
    expect(PLANS.growth.limits).toEqual(times(2));
    expect(PLANS.pro.limits).toEqual(times(5));
  });

  it("knows only its own keys", () => {
    expect(isPlanKey("growth")).toBe(true);
    expect(isPlanKey("enterprise")).toBe(false);
    expect(isPlanKey(null)).toBe(false);
    expect(isPlanKey("toString")).toBe(false);
  });
});
