import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock, transactionMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  transactionMock: vi.fn(),
}));

const TX = { tx: true };

vi.mock("@/lib/db", () => ({
  prisma: { postJob: { findFirst: findFirstMock }, $transaction: transactionMock },
}));

import { prisma } from "@/lib/db";

import {
  applyToPair,
  PAIR_HALF_SELECT,
  pairLimitArgs,
  readPairHalf,
  takenFeedHalf,
  wantsPair,
  type PairHalf,
} from "./pairRule";

function half(overrides: Partial<PairHalf> = {}): PairHalf {
  return {
    id: "story-1",
    kind: "story",
    storyOfPostJobId: "feed-1",
    status: "scheduled",
    scheduledFor: new Date("2026-11-20T15:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    updatedAt: new Date("2026-11-01T09:30:00Z"),
    submittedForApprovalAt: null,
    approvedAt: null,
    baseCaption: "Caption",
    perPlatformOverrides: null,
    publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
    coverImageUrl: null,
    mediaItem: null,
    ...overrides,
  } as PairHalf;
}

const MAIN = { id: "feed-1", status: "scheduled" as const };
const CANCEL_WORDING = { done: "was cancelled too", verb: "cancelled" };

beforeEach(() => {
  findFirstMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX));
});

describe("wantsPair", () => {
  it("is true only for includePair: true", () => {
    expect(wantsPair({ includePair: true })).toBe(true);
    expect(wantsPair({ includePair: "true" })).toBe(false);
    expect(wantsPair({})).toBe(false);
    expect(wantsPair(null)).toBe(false);
  });
});

describe("readPairHalf", () => {
  it("reads nothing when the request did not ask for the pair", async () => {
    expect(await readPairHalf("ws-1", { id: "feed-1", storyOfPostJobId: null }, false)).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("a feed post: its Story job, in this workspace, cancelled ones included so the answer can name them", async () => {
    findFirstMock.mockResolvedValue({ ...half({ status: "cancelled" }), kind: undefined });

    const found = await readPairHalf("ws-1", { id: "feed-1", storyOfPostJobId: null }, true);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { storyOfPostJobId: "feed-1", workspaceId: "ws-1" },
      orderBy: { createdAt: "asc" },
      select: PAIR_HALF_SELECT,
    });
    expect(found?.kind).toBe("story");
    expect(found?.status).toBe("cancelled");
  });

  it("a Story: its feed job, in this workspace", async () => {
    findFirstMock.mockResolvedValue({ ...half({ id: "feed-1", storyOfPostJobId: null }), kind: undefined });

    const found = await readPairHalf("ws-1", { id: "story-1", storyOfPostJobId: "feed-1" }, true);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "feed-1", workspaceId: "ws-1" },
      select: PAIR_HALF_SELECT,
    });
    expect(found?.kind).toBe("feed");
  });

  it("no other half (deleted, or a row that does not point back): null", async () => {
    findFirstMock.mockResolvedValue(null);
    expect(await readPairHalf("ws-1", { id: "feed-1", storyOfPostJobId: null }, true)).toBeNull();
    findFirstMock.mockResolvedValue(half({ storyOfPostJobId: "someone-else" }));
    expect(await readPairHalf("ws-1", { id: "feed-1", storyOfPostJobId: null }, true)).toBeNull();
    findFirstMock.mockResolvedValue(half({ id: "other", storyOfPostJobId: null }));
    expect(await readPairHalf("ws-1", { id: "story-1", storyOfPostJobId: "feed-1" }, true)).toBeNull();
  });
});

describe("applyToPair", () => {
  it("no other half: this post's write alone, outside a transaction, as before", async () => {
    const write = vi.fn().mockResolvedValue(true);

    const result = await applyToPair({ main: MAIN, half: null, write, wording: CANCEL_WORDING });

    expect(result).toEqual({ ok: true, pair: null });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(prisma, MAIN);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("a live other half: both writes in one transaction, this post first, each once", async () => {
    const write = vi.fn().mockResolvedValue(true);
    const other = half();

    const result = await applyToPair({ main: MAIN, half: other, write, wording: CANCEL_WORDING });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(write.mock.calls).toEqual([
      [TX, MAIN],
      [TX, other],
    ]);
    expect(result).toEqual({
      ok: true,
      pair: { id: "story-1", kind: "story", changed: true, note: "Its Story was cancelled too." },
    });
  });

  it("this post's write misses: nothing else is written and the answer is a miss", async () => {
    const write = vi.fn().mockResolvedValue(false);

    const result = await applyToPair({ main: MAIN, half: half(), write, wording: CANCEL_WORDING });

    expect(result).toEqual({ ok: false });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["in_progress", "Its Story has already started publishing, so it was not cancelled."],
    ["pending", "Its Story has already started publishing, so it was not cancelled."],
    ["completed", "Its Story was already published, so it was not cancelled."],
    ["failed", "Its Story was already sent and did not go out, so it was not cancelled."],
    ["cancelled", "Its Story was already cancelled, so it was not cancelled."],
  ] as const)("a %s other half is left alone and named", async (status, note) => {
    const write = vi.fn().mockResolvedValue(true);

    const result = await applyToPair({ main: MAIN, half: half({ status }), write, wording: CANCEL_WORDING });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(prisma, MAIN);
    expect(result).toEqual({ ok: true, pair: { id: "story-1", kind: "story", changed: false, note } });
  });

  it("an other half the action's own check refuses is left alone with the route's reason", async () => {
    const write = vi.fn().mockResolvedValue(true);

    const result = await applyToPair({
      main: MAIN,
      half: half({ id: "feed-1", kind: "feed", status: "draft" }),
      write,
      blocker: (other) => (other.status === "draft" ? "is not waiting for approval" : null),
      wording: { done: "was approved too", verb: "approved" },
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      pair: {
        id: "feed-1",
        kind: "feed",
        changed: false,
        note: "Its feed post is not waiting for approval, so it was not approved.",
      },
    });
  });

  it("an other half whose pinned write misses is left alone: it changed in the meantime", async () => {
    const write = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await applyToPair({ main: MAIN, half: half(), write, wording: CANCEL_WORDING });

    expect(result).toEqual({
      ok: true,
      pair: {
        id: "story-1",
        kind: "story",
        changed: false,
        note: "Its Story changed in the meantime, so it was not cancelled.",
      },
    });
  });
});

describe("pairLimitArgs", () => {
  it("counts a live other half as a second post that day, and neither half against itself", () => {
    expect(pairLimitArgs("feed-1", half())).toEqual({ excludePostJobId: ["feed-1", "story-1"], alsoOnDay: 1 });
  });

  it("without a live other half: this post alone, as before", () => {
    expect(pairLimitArgs("feed-1", null)).toEqual({ excludePostJobId: "feed-1" });
    expect(pairLimitArgs("feed-1", half({ status: "completed" }))).toEqual({ excludePostJobId: "feed-1" });
  });
});

// R4 lows, item 3: an email about a pair action describes the feed post.
describe("takenFeedHalf", () => {
  const feed = half({ id: "feed-1", kind: "feed", storyOfPostJobId: null });
  const taken = { id: "feed-1", kind: "feed" as const, changed: true, note: "Its feed post was changed too." };

  it("is the other half when it is the feed post and the action took it", () => {
    expect(takenFeedHalf(feed, taken)).toBe(feed);
  });

  it("is null when the other half is the Story, was left alone, or there is none", () => {
    expect(takenFeedHalf(half(), { ...taken, id: "story-1", kind: "story" })).toBeNull();
    expect(takenFeedHalf(feed, { ...taken, changed: false })).toBeNull();
    expect(takenFeedHalf(feed, null)).toBeNull();
    expect(takenFeedHalf(null, null)).toBeNull();
  });
});
