import { describe, expect, it } from "vitest";

import { activityEmptyState, activityFilterFromSearch, activityFilterHref } from "./activity-filter";

describe("activityFilterFromSearch", () => {
  it("selects the problems tab from ?show=problems", () => {
    expect(activityFilterFromSearch("?show=problems")).toBe("problems");
    expect(activityFilterFromSearch(new URLSearchParams("show=problems&x=1"))).toBe("problems");
  });

  it("falls back to all posts for no param or any other value", () => {
    expect(activityFilterFromSearch("")).toBe("all");
    expect(activityFilterFromSearch("?show=everything")).toBe("all");
    expect(activityFilterFromSearch(new URLSearchParams())).toBe("all");
  });
});

describe("activityFilterHref", () => {
  it("is the URL the dashboard links to, and plain /activity for all posts", () => {
    expect(activityFilterHref("problems")).toBe("/activity?show=problems");
    expect(activityFilterHref("all")).toBe("/activity");
  });
});

describe("activityEmptyState", () => {
  it("says no post has had a problem, with no create button, on the problems tab", () => {
    // R56 L1: "Every post went out." was false for an owner with only
    // scheduled posts, drafts, or none at all.
    expect(activityEmptyState("problems")).toEqual({
      title: "No post has had a problem.",
      description: null,
      showCreate: false,
    });
  });

  it("keeps the first-post empty state on all posts", () => {
    expect(activityEmptyState("all")).toEqual({
      title: "No posts yet",
      description:
        "When you publish a post, it'll appear here with a per-platform breakdown of what succeeded and what failed.",
      showCreate: true,
    });
  });
});
