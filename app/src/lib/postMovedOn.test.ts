import { describe, expect, it } from "vitest";

import { POST_GONE_TEXT, POST_NOW_DRAFT_TEXT, postMovedOnText } from "./postMovedOn";

// R30 publishing L1: a Cancel or Edit on a card that has moved on said "Only
// scheduled or draft posts can be ..."; it now says what happened and where to look.
// R31 publishing L1-L6: every post action words its "moved on" answer here.
describe("postMovedOnText", () => {
  it("started publishing", () => {
    expect(postMovedOnText("in_progress", "cancelled")).toBe(
      "This post has started publishing, so it can't be cancelled. Check Activity to see how it goes.",
    );
    expect(postMovedOnText("pending", "edited")).toBe(
      "This post has started publishing, so it can't be edited. Check Activity to see how it goes.",
    );
    expect(postMovedOnText("in_progress", "published")).toBe(
      "This post has started publishing, so it can't be published. Check Activity to see how it goes.",
    );
  });

  it("already published", () => {
    expect(postMovedOnText("completed", "cancelled")).toBe(
      "This post has already gone out, so it can't be cancelled. Check Activity to see it.",
    );
    expect(postMovedOnText("completed", "deleted")).toBe(
      "This post has already gone out, so it can't be deleted. Check Activity to see it.",
    );
  });

  it("failed, with or without results: never says it was sent (publishing L6)", () => {
    const text = "This post failed, so it can't be edited. Check Activity for what to do next.";
    expect(postMovedOnText("failed", "edited")).toBe(text);
    expect(postMovedOnText("failed", "edited")).not.toMatch(/sent/);
    expect(postMovedOnText("failed", "published")).toBe(
      "This post failed, so it can't be published. Check Activity for what to do next.",
    );
  });

  it("cancelled", () => {
    expect(postMovedOnText("cancelled", "cancelled")).toBe("This post was already cancelled.");
    expect(postMovedOnText("cancelled", "edited")).toBe("This post was cancelled, so it can't be edited.");
    expect(postMovedOnText("cancelled", "published")).toBe("This post was cancelled, so it can't be published.");
  });

  it("deleted or not found: one sentence, never a bare Not found (publishing L4)", () => {
    expect(POST_GONE_TEXT).toBe("This post no longer exists.");
    expect(postMovedOnText(null, "edited")).toBe(POST_GONE_TEXT);
    expect(postMovedOnText(undefined, "cancelled")).toBe(POST_GONE_TEXT);
  });

  it("a draft that is now scheduled can't be deleted: says to cancel it first", () => {
    expect(postMovedOnText("scheduled", "deleted")).toBe(
      "This post is scheduled now, so it can't be deleted. Cancel it first, then delete it.",
    );
  });

  it("now a draft (publishing L5)", () => {
    expect(POST_NOW_DRAFT_TEXT).toBe(
      "This post is now a draft (a change was asked for, or it is waiting for approval).",
    );
  });

  it("still scheduled or a draft, where the action fits: nothing to say here", () => {
    expect(postMovedOnText("scheduled", "cancelled")).toBeNull();
    expect(postMovedOnText("draft", "edited")).toBeNull();
    expect(postMovedOnText("draft", "deleted")).toBeNull();
    expect(postMovedOnText("scheduled", "published")).toBeNull();
  });

  // Lead review: Edit on a draft a teammate scheduled said "Only a draft can be scheduled here."
  it("a draft that is scheduled now, given a time: says someone else scheduled it", () => {
    expect(postMovedOnText("scheduled", "scheduled")).toBe("This post is scheduled now (someone else scheduled it), so the new time wasn't saved.");
  });
});
