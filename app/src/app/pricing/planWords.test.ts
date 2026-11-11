import { describe, expect, it } from "vitest";

import { PLANS } from "@/lib/plans";

import { planLimitLines } from "./planWords";

describe("planLimitLines", () => {
  it("puts the starter plan's limits in words", () => {
    expect(planLimitLines(PLANS.starter.limits)).toEqual([
      "Up to 20 posts a day",
      "Up to 30 posts to X a month",
      "Up to 10 YouTube uploads a day",
      "5 GB of photos and videos",
    ]);
  });

  it("gives storage that is not a whole number of gigabytes to one decimal", () => {
    const lines = planLimitLines({ postsPerDay: 1, xPostsPerMonth: 1, youtubeUploadsPerDay: 1, storageMb: 1536 });
    expect(lines).toContain("1.5 GB of photos and videos");
    expect(lines).toContain("Up to 1 post a day");
    expect(lines).toContain("Up to 1 post to X a month");
    expect(lines).toContain("Up to 1 YouTube upload a day");
  });
});
