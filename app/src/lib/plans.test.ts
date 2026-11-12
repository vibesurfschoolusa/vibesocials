import { describe, expect, it } from "vitest";

import { GROWTH_ADDS_LINE, isPlanKey, PLAN_INCLUDES, PLAN_KEYS, PLANS, planIncludesLine } from "./plans";
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

// P1: what each plan includes, in words true to lib/planFeatures.ts.
describe("PLAN_INCLUDES", () => {
  it("has one line per plan, as the owner approved them", () => {
    expect(PLAN_INCLUDES).toEqual({
      starter: "All your platforms, AI captions and alt text, Google posts with buttons, offers and events, AI drafts for Google review replies",
      growth:
        "Everything in Starter, plus client upload, review and connect links, a monthly report email with your logo, Add many, brand voice and new-review alerts",
      pro: "Everything in Growth, with higher limits and priority email support",
    });
  });

  it("says what Growth adds to Starter", () => {
    expect(GROWTH_ADDS_LINE).toBe(
      "Growth adds client upload, review and connect links, a monthly report email with your logo, Add many, brand voice and new-review alerts.",
    );
  });
});

// P1 fix round 2: a card never points at a plan the view does not show.
describe("planIncludesLine", () => {
  const S = "All your platforms, AI captions and alt text, Google posts with buttons, offers and events, AI drafts for Google review replies";
  const G =
    "client upload, review and connect links, a monthly report email with your logo, Add many, brand voice and new-review alerts";

  it("all three shown: the approved lines", () => {
    const shown = ["starter", "growth", "pro"] as const;
    for (const plan of shown) expect(planIncludesLine(plan, [...shown])).toBe(PLAN_INCLUDES[plan]);
  });

  it("Growth missing: Pro lists Growth's features in full", () => {
    expect(planIncludesLine("pro", ["starter", "pro"])).toBe(
      `Everything in Starter, plus ${G}, with higher limits and priority email support`,
    );
    expect(planIncludesLine("starter", ["starter", "pro"])).toBe(S);
  });

  it("only Pro: everything in full, and no 'higher' than plans not shown", () => {
    expect(planIncludesLine("pro", ["pro"])).toBe(`${S}, plus ${G}, and priority email support`);
  });

  it("Starter missing: Growth lists Starter's in full", () => {
    expect(planIncludesLine("growth", ["growth", "pro"])).toBe(`${S}, plus ${G}`);
    expect(planIncludesLine("pro", ["growth", "pro"])).toBe(PLAN_INCLUDES.pro);
  });
});
