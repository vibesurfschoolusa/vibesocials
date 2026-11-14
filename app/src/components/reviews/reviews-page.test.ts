import { describe, expect, it } from "vitest";

import {
  focusAfterReply,
  needsReplyEmptyTitle,
  replyButtonId,
  reviewsSubtitle,
  showLocationPicker,
  singleLocationName,
} from "./reviews-page";
import type { Location } from "./types";

const loc = (name: string, title: string): Location => ({ name, locationName: name, title });

// N2: the heading's subtitle carries the count instead of a separate box.
describe("reviewsSubtitle", () => {
  it("keeps the current subtitle while the reviews load", () => {
    expect(reviewsSubtitle(null, 0)).toBe("Manage and reply to your Google Business Profile reviews");
  });

  it("says every review has a reply when none wait", () => {
    expect(reviewsSubtitle(0, 41)).toBe("Every review has a reply");
  });

  it("says no reviews yet for a listing with none at all", () => {
    expect(reviewsSubtitle(0, 0)).toBe("No reviews yet");
  });

  it("uses the singular for one", () => {
    expect(reviewsSubtitle(1, 5)).toBe("1 review needs a reply");
  });

  it("uses the plural for many", () => {
    expect(reviewsSubtitle(9, 50)).toBe("9 reviews need a reply");
  });
});

describe("needsReplyEmptyTitle", () => {
  it("tells a new listing apart from one where every review has a reply", () => {
    expect(needsReplyEmptyTitle(0)).toBe("No reviews yet.");
    expect(needsReplyEmptyTitle(3)).toBe("Every review has a reply.");
  });
});

// N2: after a reply posts, focus goes to the next waiting review.
describe("focusAfterReply", () => {
  it("moves to the next review in the list", () => {
    expect(focusAfterReply(["a", "b", "c"], "a")).toBe("b");
    expect(focusAfterReply(["a", "b", "c"], "b")).toBe("c");
  });

  it("moves to the previous review when the answered one was last", () => {
    expect(focusAfterReply(["a", "b", "c"], "c")).toBe("b");
  });

  it("gives none when the list empties", () => {
    expect(focusAfterReply(["a"], "a")).toBeNull();
  });

  it("gives none when the answered review is not in the list", () => {
    expect(focusAfterReply(["a", "b"], "x")).toBeNull();
  });
});

describe("showLocationPicker", () => {
  it("shows only with two or more locations", () => {
    expect(showLocationPicker([])).toBe(false);
    expect(showLocationPicker([loc("a", "Dania")])).toBe(false);
    expect(showLocationPicker([loc("a", "Dania"), loc("b", "Pompano")])).toBe(true);
  });
});

describe("singleLocationName", () => {
  it("names the only location, through the picker's labels", () => {
    expect(singleLocationName([loc("a", "Dania")])).toBe("Dania");
    expect(singleLocationName([loc("a", "  ")])).toBe("Unnamed location");
  });

  it("gives none with zero or several locations", () => {
    expect(singleLocationName([])).toBeNull();
    expect(singleLocationName([loc("a", "Dania"), loc("b", "Pompano")])).toBeNull();
  });
});

describe("replyButtonId", () => {
  it("gives each review's Reply button its own id", () => {
    expect(replyButtonId("abc")).toBe("reply-to-abc");
    expect(replyButtonId("abc")).not.toBe(replyButtonId("abd"));
  });
});
