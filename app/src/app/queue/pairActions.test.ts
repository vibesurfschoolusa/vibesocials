import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";

import {
  isPairCard,
  pairCancelMessage,
  pairDeleteFailedMessage,
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
describe("pairOption", () => {
  it("a feed post's cancel names its Story and its time, and offers to cancel it too", () => {
    expect(pairOption(pair(), "cancel")).toEqual({
      line: `This post also goes out as a Story, set for ${formatted}.`,
      label: "Also cancel the Story",
      keptLine: "The Story is kept and keeps its time.",
    });
  });

  it("a Story's cancel names its feed post and its time", () => {
    expect(pairOption(pair({ kind: "feed", id: "feed-1" }), "cancel")).toEqual({
      line: `This is the Story of a feed post set for ${formatted}.`,
      label: "Also cancel the feed post",
      keptLine: "The feed post is kept and keeps its time.",
    });
  });

  it("says when the other half has no time set", () => {
    expect(pairOption(pair({ status: "draft", scheduledFor: null }), "cancel")?.line).toBe(
      "This post also goes out as a Story, with no time set.",
    );
  });

  it("an other half that already started publishing is named but not offered", () => {
    expect(pairOption(pair({ status: "in_progress" }), "cancel")).toEqual({
      line: `This post also goes out as a Story, set for ${formatted}. It has already started publishing, so it is not changed.`,
      label: null,
      keptLine: null,
    });
  });

  it("delete offers only a draft other half; a scheduled one stays", () => {
    expect(pairOption(pair({ status: "draft" }), "delete")?.label).toBe("Also delete the Story");
    expect(pairOption(pair({ kind: "feed", status: "draft" }), "delete")?.label).toBe("Also delete the feed post");
    expect(pairOption(pair({ status: "scheduled" }), "delete")).toEqual({
      line: `This post also goes out as a Story, set for ${formatted}. It is scheduled, so it is not deleted; cancel it on its own card first.`,
      label: null,
      keptLine: null,
    });
  });

  it("no other half (none, or already cancelled): nothing to show", () => {
    expect(pairOption(null, "cancel")).toBeNull();
    expect(pairOption(null, "delete")).toBeNull();
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
