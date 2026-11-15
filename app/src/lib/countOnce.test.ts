import { describe, expect, it } from "vitest";

import { countPostsOnce, withoutPairedStories } from "./countOnce";

const feed = { id: "feed-1", storyOfPostJobId: null };
const story = { id: "story-1", storyOfPostJobId: "feed-1" };
const lone = { id: "post-2", storyOfPostJobId: null };

describe("the count-once rule for a Feed and Story post", () => {
  it("leaves out a Story whose feed job is in the list", () => {
    expect(withoutPairedStories([feed, story, lone])).toEqual([feed, lone]);
    expect(withoutPairedStories([story, feed])).toEqual([feed]);
  });

  it("keeps a Story whose feed job is not in the list", () => {
    expect(withoutPairedStories([story, lone])).toEqual([story, lone]);
  });

  it("counts a pair once and every other job once", () => {
    expect(countPostsOnce([feed, story, lone])).toBe(2);
    expect(countPostsOnce([story])).toBe(1);
    expect(countPostsOnce([])).toBe(0);
  });

  it("counts a job listed twice (two failed platforms) once", () => {
    expect(countPostsOnce([feed, feed, story, story])).toBe(1);
  });
});
