import { describe, expect, it } from "vitest";

import { PLANS } from "@/lib/plans";

import { planLimitLines } from "./planWords";

describe("planLimitLines", () => {
  it("puts the starter plan's limits in words", () => {
    expect(planLimitLines(PLANS.starter.limits)).toEqual([
      "Up to 3 posts a day (about 90 a month)",
      "Up to 15 posts to X a month",
      "Up to 1 YouTube upload a day",
      "2 GB of photos and videos",
    ]);
  });

  it("puts the growth and pro plans in words", () => {
    expect(planLimitLines(PLANS.growth.limits)).toEqual([
      "Up to 6 posts a day (about 180 a month)",
      "Up to 40 posts to X a month",
      "Up to 3 YouTube uploads a day",
      "5 GB of photos and videos",
    ]);
    expect(planLimitLines(PLANS.pro.limits)).toEqual([
      "Up to 15 posts a day (about 450 a month)",
      "Up to 100 posts to X a month",
      "Up to 5 YouTube uploads a day",
      "15 GB of photos and videos",
    ]);
  });

  it("gives storage that is not a whole number of gigabytes to one decimal", () => {
    const lines = planLimitLines({ postsPerDay: 1, xPostsPerMonth: 1, youtubeUploadsPerDay: 1, storageMb: 1536 });
    expect(lines).toContain("1.5 GB of photos and videos");
    expect(lines).toContain("Up to 1 post a day (about 30 a month)");
    expect(lines).toContain("Up to 1 post to X a month");
    expect(lines).toContain("Up to 1 YouTube upload a day");
  });
});
