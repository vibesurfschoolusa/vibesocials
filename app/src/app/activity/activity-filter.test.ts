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
  it("says nothing went wrong, with no create button, on the problems tab", () => {
    expect(activityEmptyState("problems")).toEqual({
      title: "Nothing went wrong. Every post went out.",
      description: null,
      showCreate: false,
    });
  });

  it("keeps the first-post empty state on all posts", () => {
    const empty = activityEmptyState("all");
    expect(empty.title).toBe("No posts yet");
    expect(empty.showCreate).toBe(true);
  });
});
