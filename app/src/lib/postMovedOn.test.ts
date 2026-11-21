import { describe, expect, it } from "vitest";

import {
  lostRaceAnswer,
  POST_CHANGED_CODE,
  POST_CHANGED_TEXT,
  POST_GONE_TEXT,
  POST_NOW_DRAFT_TEXT,
  postMovedOnText,
} from "./postMovedOn";

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

  // R32 publishing L2: a lost "Submit for approval" claim words the post's state too.
  it("sent for approval", () => {
    expect(postMovedOnText("in_progress", "sent for approval")).toBe(
      "This post has started publishing, so it can't be sent for approval. Check Activity to see how it goes.",
    );
    expect(postMovedOnText("completed", "sent for approval")).toBe(
      "This post has already gone out, so it can't be sent for approval. Check Activity to see it.",
    );
    expect(postMovedOnText("scheduled", "sent for approval")).toBeNull();
    expect(postMovedOnText("draft", "sent for approval")).toBeNull();
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

// R60 publishing-flow L1, L2, pages-a L1: a pinned write that matched nothing is
// worded here alone. A post the action still fits changed in the meantime (its
// own code, so a page can word it for where it is shown); one that moved on
// keeps its moved-on sentence and the route's code.
describe("lostRaceAnswer", () => {
  it("the code and the sentence", () => {
    expect(POST_CHANGED_CODE).toBe("POST_CHANGED");
    expect(POST_CHANGED_TEXT).toBe("This post changed in the meantime. Try again.");
  });

  it.each([
    ["draft", "published"],
    ["scheduled", "published"],
    ["draft", "scheduled"],
    ["draft", "sent for approval"],
    ["scheduled", "sent for approval"],
    ["draft", "edited"],
    ["scheduled", "edited"],
    ["draft", "cancelled"],
    ["scheduled", "cancelled"],
  ] as const)("still %s, the action (%s) can go ahead: changed in the meantime", (status, verb) => {
    expect(lostRaceAnswer({ status }, verb, { code: "NOT_X" })).toEqual({ error: POST_CHANGED_TEXT, code: POST_CHANGED_CODE });
  });

  it.each([
    [{ status: "in_progress" as const }, "published", "This post has started publishing, so it can't be published. Check Activity to see how it goes."],
    [{ status: "completed" as const }, "edited", "This post has already gone out, so it can't be edited. Check Activity to see it."],
    [{ status: "failed" as const }, "sent for approval", "This post failed, so it can't be sent for approval. Check Activity for what to do next."],
    [{ status: "cancelled" as const }, "cancelled", "This post was already cancelled."],
    [null, "cancelled", "This post no longer exists."],
    [undefined, "published", "This post no longer exists."],
    // A draft a teammate scheduled meanwhile: Schedule no longer fits it.
    [{ status: "scheduled" as const }, "scheduled", "This post is scheduled now (someone else scheduled it), so the new time wasn't saved."],
  ] as const)("moved on (%o, %s): the moved-on sentence and the route's code", (reRead, verb, error) => {
    expect(lostRaceAnswer(reRead, verb, { code: "NOT_X" })).toEqual({ error, code: "NOT_X" });
  });

  it("a route's line after a moved-on sentence, never after the changed one", () => {
    const after = "The later posts in this series were left as they are: cancel them on their own cards.";
    expect(lostRaceAnswer({ status: "in_progress" }, "cancelled", { code: "NOT_CANCELABLE", after })).toEqual({
      error: `This post has started publishing, so it can't be cancelled. Check Activity to see how it goes. ${after}`,
      code: "NOT_CANCELABLE",
    });
    expect(lostRaceAnswer({ status: "draft" }, "cancelled", { code: "NOT_CANCELABLE", after })).toEqual({
      error: POST_CHANGED_TEXT,
      code: POST_CHANGED_CODE,
    });
  });
});
