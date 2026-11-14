import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  isPairCard,
  pairAlreadyDeletedMessage,
  pairCancelMessage,
  pairDeleteFailedMessage,
  pairLookupFailedLine,
  pairLookupState,
  pairOption,
  pairRejectedNote,
  pairRescheduleNote,
  type PairInfo,
} from "./pairActions";

const AT = "2026-11-20T15:00:00.000Z";
const formatted = new Date(AT).toLocaleString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function pair(overrides: Partial<PairInfo> = {}): PairInfo {
  return { id: "story-1", kind: "story", status: "scheduled", scheduledFor: AT, ...overrides };
}

type Card = Pick<PostJobDTO, "storyOf" | "alsoAsStory">;
const feedCard: Card = { alsoAsStory: true };
const storyCard: Card = { storyOf: { scheduledFor: AT } };
const plainCard: Card = {};

// R2-client-journey M1: the cancel and delete dialogs name the other half of a
// Feed and Story post and its time, and offer to include it (checked by default).
const NOW = new Date("2026-11-14T12:00:00.000Z").getTime();
const PAST = "2026-11-10T15:00:00.000Z";
const pastFormatted = new Date(PAST).toLocaleString(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

describe("pairOption", () => {
  it("a feed post's cancel names its Story and its time, and offers to cancel it too", () => {
    expect(pairOption(pair(), "cancel", NOW)).toEqual({
      line: `This post also goes out as a Story, set for ${formatted}.`,
      label: "Also cancel the Story",
      keptLine: "The Story is kept and keeps its time.",
    });
  });

  it("a Story's cancel names its feed post and its time", () => {
    expect(pairOption(pair({ kind: "feed", id: "feed-1" }), "cancel", NOW)).toEqual({
      line: `This is the Story of a feed post set for ${formatted}.`,
      label: "Also cancel the feed post",
      keptLine: "The feed post is kept and keeps its time.",
    });
  });

  it("says when the other half has no time set", () => {
    expect(pairOption(pair({ status: "draft", scheduledFor: null }), "cancel", NOW)?.line).toBe(
      "This post also goes out as a Story, with no time set.",
    );
  });

  // Coordinator review point 3: a time that has passed reads as past.
  it("a time that has passed reads as past", () => {
    expect(pairOption(pair({ status: "draft", scheduledFor: PAST }), "cancel", NOW)?.line).toBe(
      `This post also has a Story, which was set for ${pastFormatted}.`,
    );
    expect(pairOption(pair({ kind: "feed", status: "draft", scheduledFor: PAST }), "cancel", NOW)?.line).toBe(
      `This is the Story of a feed post that was set for ${pastFormatted}.`,
    );
  });

  // Coordinator review point 3: the wording follows the other half's state.
  it.each([
    ["in_progress", "has already started publishing"],
    ["pending", "has already started publishing"],
    ["completed", "was already published"],
    ["failed", "did not go out"],
  ] as const)("an other half that is %s is named but not offered", (status, phrase) => {
    expect(pairOption(pair({ status }), "cancel", NOW)).toEqual({
      line: `This post's Story ${phrase}, so it is not changed.`,
      label: null,
      keptLine: null,
    });
    expect(pairOption(pair({ kind: "feed", status }), "delete", NOW)).toEqual({
      line: `This is the Story of a feed post that ${phrase}, so it is not changed.`,
      label: null,
      keptLine: null,
    });
  });

  it("delete offers only a draft other half; a scheduled one stays", () => {
    expect(pairOption(pair({ status: "draft" }), "delete", NOW)?.label).toBe("Also delete the Story");
    expect(pairOption(pair({ kind: "feed", status: "draft" }), "delete", NOW)?.label).toBe("Also delete the feed post");
    expect(pairOption(pair({ status: "scheduled" }), "delete", NOW)).toEqual({
      line: `This post also goes out as a Story, set for ${formatted}. It is scheduled, so it is not deleted; cancel it on its own card first.`,
      label: null,
      keptLine: null,
    });
  });

  it("no other half (none, or already cancelled): nothing to show", () => {
    expect(pairOption(null, "cancel", NOW)).toBeNull();
    expect(pairOption(null, "delete", NOW)).toBeNull();
  });
});

// Coordinator review points 1 and 2: the dialog waits for the lookup, and says when it failed.
describe("pairLookupState", () => {
  const card = { id: "f", alsoAsStory: true };
  it("a card of no pair: done, no pair, never blocked", () => {
    expect(pairLookupState({ id: "a" }, null)).toEqual({ loading: false, failed: false, pair: null });
  });
  it("while the lookup runs: loading (Confirm stays disabled)", () => {
    expect(pairLookupState(card, { jobId: "f" })).toEqual({ loading: true, failed: false, pair: null });
  });
  it("answered: the pair, or none", () => {
    expect(pairLookupState(card, { jobId: "f", pair: pair() })).toEqual({ loading: false, failed: false, pair: pair() });
    expect(pairLookupState(card, { jobId: "f", pair: null })).toEqual({ loading: false, failed: false, pair: null });
  });
  it("failed: not loading, so Confirm works, and the dialog says so", () => {
    expect(pairLookupState(card, { jobId: "f", failed: true })).toEqual({ loading: false, failed: true, pair: null });
  });
  it("a lookup for another card does not count", () => {
    expect(pairLookupState(card, { jobId: "other", pair: pair() })).toEqual({ loading: false, failed: false, pair: null });
  });
});

describe("pairLookupFailedLine", () => {
  it("says only this post is changed", () => {
    expect(pairLookupFailedLine({ alsoAsStory: true }, "cancel")).toBe(
      "Couldn't check whether this post has a Story half. Only this post will be cancelled.",
    );
    expect(pairLookupFailedLine({ storyOf: { scheduledFor: null } }, "delete")).toBe(
      "Couldn't check whether this post has a feed post half. Only this post will be deleted.",
    );
  });
});

// Coordinator review point 4.
describe("pairAlreadyDeletedMessage", () => {
  it("says the other half was already gone", () => {
    expect(pairAlreadyDeletedMessage("story")).toBe("The draft was deleted. Its Story had already been deleted.");
    expect(pairAlreadyDeletedMessage("feed")).toBe("The draft was deleted. Its feed post had already been deleted.");
  });
});

describe("isPairCard", () => {
  it("is true for either half, false otherwise", () => {
    expect(isPairCard(feedCard)).toBe(true);
    expect(isPairCard(storyCard)).toBe(true);
    expect(isPairCard(plainCard)).toBe(false);
  });
});

describe("pairCancelMessage", () => {
  it("says what happened to both halves", () => {
    expect(pairCancelMessage("cancelled", "story")).toBe("Post and its Story cancelled.");
    expect(pairCancelMessage("cancelled", "feed")).toBe("Story and its feed post cancelled.");
    expect(pairCancelMessage("not_cancelable", "story")).toBe(
      "Post cancelled. Its Story had already started publishing or changed, so it was not cancelled.",
    );
    expect(pairCancelMessage("none", "story")).toBe("Scheduled post cancelled.");
    expect(pairCancelMessage(undefined, "feed")).toBe("Scheduled post cancelled.");
  });
});

describe("pairDeleteFailedMessage", () => {
  it("says the draft went and the other half did not", () => {
    expect(pairDeleteFailedMessage("story", "Only draft or cancelled posts can be deleted.")).toBe(
      "The draft was deleted, but its Story was not: Only draft or cancelled posts can be deleted.",
    );
  });
});

describe("pairRejectedNote", () => {
  it("names the other half that was rejected with this one", () => {
    expect(pairRejectedNote(feedCard)).toBe(" Its Story was rejected too.");
    expect(pairRejectedNote(storyCard)).toBe(" Its feed post was rejected too.");
    expect(pairRejectedNote(plainCard)).toBe("");
  });
});

describe("pairRescheduleNote", () => {
  it("tells the owner the other half keeps its time", () => {
    expect(pairRescheduleNote(feedCard)).toBe("Its Story keeps its own time. Change it on the Story's card if it should move too.");
    expect(pairRescheduleNote(storyCard)).toBe("The feed post keeps its own time. Change it on its card if it should move too.");
    expect(pairRescheduleNote(plainCard)).toBeNull();
  });
});
