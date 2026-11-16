import { describe, expect, it } from "vitest";

import { postMovedOnText } from "./postMovedOn";

// R30 publishing L1: a Cancel or Edit on a card that has moved on said "Only
// scheduled or draft posts can be ..."; it now says what happened and where to look.
describe("postMovedOnText", () => {
  it("started publishing", () => {
    expect(postMovedOnText("in_progress", "cancelled")).toBe(
      "This post has started publishing, so it can't be cancelled. Check Activity to see how it goes.",
    );
    expect(postMovedOnText("pending", "edited")).toBe(
      "This post has started publishing, so it can't be edited. Check Activity to see how it goes.",
    );
  });

  it("already published", () => {
    expect(postMovedOnText("completed", "cancelled")).toBe(
      "This post has already gone out, so it can't be cancelled. Check Activity to see it.",
    );
  });

  it("failed", () => {
    expect(postMovedOnText("failed", "edited")).toBe(
      "This post was already sent and failed, so it can't be edited. Check Activity to see what happened.",
    );
  });

  it("cancelled", () => {
    expect(postMovedOnText("cancelled", "cancelled")).toBe("This post was already cancelled.");
    expect(postMovedOnText("cancelled", "edited")).toBe("This post was cancelled, so it can't be edited.");
  });

  it("still scheduled or a draft, or unknown: nothing to say here", () => {
    expect(postMovedOnText("scheduled", "cancelled")).toBeNull();
    expect(postMovedOnText("draft", "edited")).toBeNull();
    expect(postMovedOnText(null, "edited")).toBeNull();
  });
});
