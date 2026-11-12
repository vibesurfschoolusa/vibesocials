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

  // S1 item 4: the numbers the owner chose with the prices on 2026-11-11.
  it("has the chosen limits for each plan", () => {
    expect(PLANS.starter.limits).toEqual({ postsPerDay: 3, xPostsPerMonth: 15, youtubeUploadsPerDay: 1, storageMb: 2048 });
    expect(PLANS.growth.limits).toEqual({ postsPerDay: 6, xPostsPerMonth: 40, youtubeUploadsPerDay: 3, storageMb: 5120 });
    expect(PLANS.pro.limits).toEqual({ postsPerDay: 15, xPostsPerMonth: 100, youtubeUploadsPerDay: 5, storageMb: 15360 });
  });

  it("leaves the defaults for exempt workspaces and billing off as they were", () => {
    expect(DEFAULT_WORKSPACE_LIMITS).toEqual({
      postsPerDay: 20,
      xPostsPerMonth: 30,
      youtubeUploadsPerDay: 10,
      storageBytes: 5120 * MB,
    });
  });

  it("knows only its own keys", () => {
    expect(isPlanKey("growth")).toBe(true);
    expect(isPlanKey("enterprise")).toBe(false);
    expect(isPlanKey(null)).toBe(false);
    expect(isPlanKey("toString")).toBe(false);
  });
});
