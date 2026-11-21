import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findFirstMock,
  transactionMock,
  prepareMock,
  sendMock,
  failPendingMock,
  withdrawSendMock,
  resultFindFirstMock,
  resultCountMock,
  resultFindManyMock,
  reserveMock,
  canSendMock,
} =
  vi.hoisted(() => ({
    resultFindManyMock: vi.fn(),
    resultCountMock: vi.fn(),
    reserveMock: vi.fn(),
    canSendMock: vi.fn(),
    findFirstMock: vi.fn(),
    transactionMock: vi.fn(),
    prepareMock: vi.fn(),
    sendMock: vi.fn(),
    failPendingMock: vi.fn(),
    withdrawSendMock: vi.fn(),
    resultFindFirstMock: vi.fn(),
  }));

const TX = { tx: true };

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock },
    postJobResult: { findFirst: resultFindFirstMock, count: resultCountMock, findMany: resultFindManyMock },
    $transaction: transactionMock,
  },
}));
// dispatchNow: the prepare and the send are mocked; the event builder is real.
vi.mock("@/server/jobs/posting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/posting")>()),
  prepareDeferredPostJobDispatch: prepareMock,
  deferredPostCanSend: canSendMock,
}));
vi.mock("@/lib/inngest", () => ({ inngest: { send: sendMock } }));
vi.mock("@/server/jobs/failPendingResults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/failPendingResults")>()),
  failPendingPostJobResults: failPendingMock,
}));
vi.mock("@/server/usage/usageLog", () => ({ withdrawSend: withdrawSendMock, reserveFreeRuns: reserveMock }));

import { prisma } from "@/lib/db";
import type { ConnectionStep } from "@/lib/connectionSteps";

import {
  applyToPair,
  dispatchNow,
  failedStartAnswer,
  notSentNote,
  partialSendMessage,
  PAIR_HALF_SELECT,
  pairLimitArgs,
  readPairHalf,
  releaseReservation,
  reserveSendNow,
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
    // R32 client-journey L7: a failed half may never have been sent (as postMovedOnText).
    ["failed", "Its Story failed, so it was not cancelled. Check Activity for what to do next."],
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

// Third review of K2: publish and approve hand posts over through dispatchNow;
// a send exists only for a post handed to publishing.
describe("dispatchNow - the sends of a failed hand-over", () => {
  const DAY = new Date("2026-11-14T15:00:00Z");
  const ok = (id: string, sendsWritten?: { postJobIds: string[]; day: Date }) => ({
    ok: true,
    ...(sendsWritten ? { sendsWritten } : {}),
    event: { postJobId: id, userId: "u", workspaceId: "ws", mediaItemId: null, baseCaption: "c", perPlatformOverrides: null },
  });

  beforeEach(() => {
    prepareMock.mockReset();
    sendMock.mockReset();
    failPendingMock.mockReset();
    failPendingMock.mockResolvedValue({ failedCount: 1, unconfirmedCount: 0, status: "failed" });
    withdrawSendMock.mockReset();
    withdrawSendMock.mockResolvedValue(undefined);
    resultFindFirstMock.mockReset();
    resultFindFirstMock.mockResolvedValue(null);
  });

  it("dispatch fails on the first send today: the sends prepare wrote are taken back", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id, { postJobIds: [id], day: DAY }));
    sendMock.mockRejectedValue(new Error("inngest down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect(result.sendFailed).toBe(true);
    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["feed-1"], day: DAY });
    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["story-1"], day: DAY });
  });

  it("a send already there from earlier that day (prepare wrote none) stays", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    sendMock.mockRejectedValue(new Error("inngest down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatchNow(["feed-1"], { route: "test" });

    expect(withdrawSendMock).not.toHaveBeenCalled();
  });

  // R26 LL3 item 1: the create route's rule. Marking is per job and never
  // throws out of dispatchNow; a job left pending keeps its send (it may still
  // publish), and the answer says whether every job was marked.
  it("the hand-over and the marking both fail: no throw, resultsMarked false, only marked sends taken back", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id, { postJobIds: [id], day: DAY }));
    sendMock.mockRejectedValue(new Error("inngest down"));
    failPendingMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("db blip");
      return { failedCount: 1, unconfirmedCount: 0, status: "failed" };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect(result.sendFailed).toBe(true);
    expect(result.resultsMarked).toBe(false);
    expect(failPendingMock.mock.calls.map(([id]) => id)).toEqual(["feed-1", "story-1"]);
    expect(withdrawSendMock).toHaveBeenCalledTimes(1);
    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["feed-1"], day: DAY });
  });

  it("the hand-over fails and every job is marked: resultsMarked true", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    sendMock.mockRejectedValue(new Error("inngest down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });
    expect(result.sendFailed).toBe(true);
    expect(result.resultsMarked).toBe(true);
  });

  it("prepare throws and the marking fails too: resultsMarked false", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    failPendingMock.mockRejectedValue(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatchNow(["feed-1"], { route: "test" });
    expect(result.sendFailed).toBe(true);
    expect(result.resultsMarked).toBe(false);
  });

  it("a hand-over that succeeds takes nothing back", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id, { postJobIds: [id], day: DAY }));
    sendMock.mockResolvedValue({ ids: [] });
    await dispatchNow(["feed-1"], { route: "test" });
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });
});

// Second look at T1, item 1: publish and approve now reserve before they claim.
describe("reserveSendNow", () => {
  const CHECK_FAILED = { error: "We couldn't check today's limits. Try again in a minute.", code: "LIMIT_CHECK_FAILED" };
  const FULL = {
    error: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
    code: "SERVICE_DAILY_POST_LIMIT",
  };
  const args = { workspaceId: "ws-1", postJobIds: ["feed-1", "story-1"], viewerUserId: "owner-1" };

  beforeEach(() => {
    reserveMock.mockReset();
    canSendMock.mockReset();
    canSendMock.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reserves every half that can send in one reservation: both or neither", async () => {
    reserveMock.mockResolvedValue({ ok: true, written: ["feed-1", "story-1"] });
    const outcome = await reserveSendNow(args);
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      postJobIds: ["feed-1", "story-1"],
      at: expect.any(Date),
      check: "now",
      viewerUserId: "owner-1",
    });
    expect(outcome).toEqual({ ok: true, reserved: { postJobIds: ["feed-1", "story-1"], day: expect.any(Date) } });
  });

  it("passes the approver's steps on to the reservation, and only when asked", async () => {
    reserveMock.mockResolvedValue({ ok: true, written: ["feed-1"] });
    await reserveSendNow({ ...args, steps: "approval" });
    expect(reserveMock).toHaveBeenCalledWith(expect.objectContaining({ steps: "approval" }));
    reserveMock.mockClear();
    await reserveSendNow(args);
    expect(reserveMock.mock.calls[0]![0]).not.toHaveProperty("steps");
  });

  it("a half with nothing it can send is not reserved (it makes no run)", async () => {
    canSendMock.mockImplementation(async (id: string) => id === "feed-1");
    reserveMock.mockResolvedValue({ ok: true, written: ["feed-1"] });
    await reserveSendNow(args);
    expect(reserveMock).toHaveBeenCalledWith(expect.objectContaining({ postJobIds: ["feed-1"] }));
  });

  it("refused: 429 with the limit's sentence", async () => {
    reserveMock.mockResolvedValue({ ok: false, refusal: FULL, ceiling: true });
    await expect(reserveSendNow(args)).resolves.toEqual({ ok: false, status: 429, body: FULL });
  });

  it("a reservation that throws (a lock timeout, the database): 503 with the try-again sentence", async () => {
    reserveMock.mockRejectedValue(new Error("Transaction already closed: timeout"));
    await expect(reserveSendNow(args)).resolves.toEqual({ ok: false, status: 503, body: CHECK_FAILED });
  });
});

describe("releaseReservation", () => {
  const DAY = new Date("2026-11-14T15:00:00Z");
  beforeEach(() => {
    withdrawSendMock.mockReset();
    withdrawSendMock.mockResolvedValue(undefined);
  });

  it("takes back the runs of the halves the claim did not take, and only those", async () => {
    await releaseReservation({ postJobIds: ["feed-1", "story-1"], day: DAY }, ["feed-1"]);
    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["story-1"], day: DAY });
    withdrawSendMock.mockClear();
    await releaseReservation({ postJobIds: ["feed-1", "story-1"], day: DAY });
    expect(withdrawSendMock).toHaveBeenCalledWith({ postJobIds: ["feed-1", "story-1"], day: DAY });
    withdrawSendMock.mockClear();
    await releaseReservation({ postJobIds: ["feed-1"], day: DAY }, ["feed-1"]);
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });
});

// R28 publishing L2: a start that fails inside prepare can leave a post with no
// results at all. Its card then offers Send again, not Retry, so the answer
// names the posts left that way and the sentences say "press Send again".
describe("dispatchNow - posts left without results", () => {
  const ok = (id: string) => ({
    ok: true,
    event: { postJobId: id, userId: "u", workspaceId: "ws", mediaItemId: null, baseCaption: "c", perPlatformOverrides: null },
  });

  beforeEach(() => {
    prepareMock.mockReset();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ids: [] });
    failPendingMock.mockReset();
    failPendingMock.mockResolvedValue({ failedCount: 0, unconfirmedCount: 0, status: "failed" });
    withdrawSendMock.mockReset();
    withdrawSendMock.mockResolvedValue(undefined);
    resultCountMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prepare throws before writing any result: the post is reported as left without results", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    resultCountMock.mockResolvedValue(0);

    const result = await dispatchNow(["feed-1"], { route: "test" });

    expect(result.sendFailed).toBe(true);
    expect([...result.withoutResults]).toEqual(["feed-1"]);
    expect(resultCountMock).toHaveBeenCalledWith({ where: { postJobId: "feed-1" } });
  });

  it("a pair where only the first half got its results: only the other half is reported", async () => {
    prepareMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("pool timeout");
      return ok(id);
    });
    resultCountMock.mockImplementation(async ({ where }: { where: { postJobId: string } }) => (where.postJobId === "feed-1" ? 2 : 0));

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect([...result.withoutResults]).toEqual(["story-1"]);
  });

  it("the count can't be read: nothing is reported, and the answer is still the 503", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    resultCountMock.mockRejectedValue(new Error("db down"));

    const result = await dispatchNow(["feed-1"], { route: "test" });

    expect(result.sendFailed).toBe(true);
    expect(result.withoutResults.size).toBe(0);
  });

  it("the marking fails too: a post with no results is still reported", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    failPendingMock.mockRejectedValue(new Error("db blip"));
    resultCountMock.mockResolvedValue(0);

    const result = await dispatchNow(["feed-1"], { route: "test" });

    expect(result.resultsMarked).toBe(false);
    expect([...result.withoutResults]).toEqual(["feed-1"]);
  });

  it("the hand-over fails after prepare: every post has its results, so none is reported and none is counted", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    sendMock.mockRejectedValue(new Error("inngest down"));

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect(result.sendFailed).toBe(true);
    expect(result.withoutResults.size).toBe(0);
    expect(resultCountMock).not.toHaveBeenCalled();
  });

  it("a hand-over that succeeds reports none", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    const result = await dispatchNow(["feed-1"], { route: "test" });
    expect(result.withoutResults.size).toBe(0);
    expect(resultCountMock).not.toHaveBeenCalled();
  });
});

describe("dispatchNow - with the route's reservation", () => {
  const DAY = new Date("2026-11-14T15:00:00Z");
  const reserved = { postJobIds: ["feed-1", "story-1"], day: DAY };
  const ok = (id: string) => ({
    ok: true,
    event: { postJobId: id, userId: "u", workspaceId: "ws", mediaItemId: null, baseCaption: "c", perPlatformOverrides: null },
  });

  beforeEach(() => {
    prepareMock.mockReset();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ids: [] });
    failPendingMock.mockReset();
    failPendingMock.mockResolvedValue({ failedCount: 1, unconfirmedCount: 0, status: "failed" });
    withdrawSendMock.mockReset();
    withdrawSendMock.mockResolvedValue(undefined);
    resultFindFirstMock.mockReset();
    resultFindFirstMock.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("uses it: prepare does not reserve again, and nothing is taken back on success", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" }, { reserved });
    expect(prepareMock.mock.calls).toEqual([
      ["feed-1", { reserved: true }],
      ["story-1", { reserved: true }],
    ]);
    expect(result.sendFailed).toBe(false);
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });

  it("prepare throws on the second half: both failed, the reservation taken back, no event, 503", async () => {
    prepareMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("pool timeout");
      return ok(id);
    });

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" }, { reserved });

    expect(sendMock).not.toHaveBeenCalled();
    expect(failPendingMock.mock.calls.map(([id]) => id).sort()).toEqual(["feed-1", "story-1"]);
    expect(failPendingMock).toHaveBeenCalledWith("story-1", {
      errorCode: "DISPATCH_FAILED",
      errorMessage: "Couldn't start publishing. Please try again.",
    });
    expect(withdrawSendMock).toHaveBeenCalledWith(reserved);
    expect(result.sendFailed).toBe(true);
  });

  it("the hand-over fails: the reservation is taken back, as before", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    sendMock.mockRejectedValue(new Error("inngest down"));
    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" }, { reserved });
    expect(result.sendFailed).toBe(true);
    expect(withdrawSendMock).toHaveBeenCalledWith(reserved);
  });

  it("without a reservation (no other caller today) prepare reserves as it goes out", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    await dispatchNow(["feed-1"], { route: "test" });
    expect(prepareMock).toHaveBeenCalledWith("feed-1", { sendNow: true });
  });
});

// R11-publishing L1: the answer to Publish now / Send again is worded for its reader.
describe("partialSendMessage and notSentNote - worded for the viewer's role", () => {
  const dispatch = (
    why: Map<string, { errorMessage: string; platform: "facebook_page" } | null>,
    connectionSteps: Map<string, ConnectionStep[]> = new Map(),
  ) => ({
    sent: new Set(["feed-1"]),
    notSent: new Set(["story-1"]),
    reasons: new Map([["story-1", "NO_CONNECTIONS"]]),
    whyNotSent: why,
    connectionSteps,
    limitRefusals: new Map(),
    sendFailed: false,
    resultsMarked: true,
    unmarked: new Set<string>(),
    withoutResults: new Set<string>(),
  });
  const reconnect = new Map([["story-1", { errorMessage: "Reconnect Facebook Page in Settings, then retry.", platform: "facebook_page" as const }]]);

  it("owner: the stored sentence as it is", () => {
    expect(partialSendMessage("feed-1", half(), dispatch(reconnect), "owner")).toBe(
      "The feed post is being sent. The Story was not: Reconnect Facebook Page in Settings, then retry.",
    );
  });

  it("member: the stored sentence's member form (only the owner can reconnect)", () => {
    expect(partialSendMessage("feed-1", half(), dispatch(reconnect), "member")).toBe(
      "The feed post is being sent. The Story was not: The workspace owner can reconnect Facebook Page; then retry.",
    );
  });

  // R59 pages-a L1: the step is worded from the half's failed rows; not known, "connect or reconnect".
  it("no stored sentence: owner is pointed at Activity for the step; member is told the owner can", () => {
    const none = new Map([["story-1", null]]);
    expect(partialSendMessage("feed-1", half(), dispatch(none), "owner")).toBe(
      "The feed post is being sent. The Story was not: each of its platforms is either not connected or needs reconnecting. Activity shows what to connect or reconnect.",
    );
    expect(partialSendMessage("feed-1", half(), dispatch(none), "member")).toBe(
      "The feed post is being sent. The Story was not: each of its platforms is either not connected or needs reconnecting. Activity shows what didn't go out; the workspace owner can connect or reconnect it.",
    );
    const gone = new Map([["story-1", ["connect" as const]]]);
    expect(partialSendMessage("feed-1", half(), dispatch(none, gone), "owner")).toBe(
      "The feed post is being sent. The Story was not: each of its platforms is either not connected or needs reconnecting. Activity shows what to connect.",
    );
  });

  it("notSentNote: owner and member forms, for each reason", () => {
    const LEAD = "Its Story was not sent: each of its platforms is either not connected or needs reconnecting.";
    expect(notSentNote("story", "owner", ["reconnect"])).toBe(`${LEAD} Activity shows what to reconnect.`);
    expect(notSentNote("story", "member", ["reconnect"])).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can reconnect it.`,
    );
    expect(notSentNote("story", "owner", ["connect"])).toBe(`${LEAD} Activity shows what to connect.`);
    expect(notSentNote("story", "member", ["connect"])).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can connect it.`,
    );
    expect(notSentNote("story", "owner")).toBe(`${LEAD} Activity shows what to connect or reconnect.`);
  });

  it("dispatchNow reads each unsent post's failed rows for its steps, whether or not anything went out", async () => {
    prepareMock.mockReset();
    prepareMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });
    resultFindManyMock.mockReset();
    resultFindManyMock.mockImplementation(async ({ where }: { where: { postJobId: string } }) =>
      where.postJobId === "feed-1"
        ? [
            { platform: "x", status: "failed", errorCode: "CONNECTION_GONE" },
            { platform: "instagram", status: "failed", errorCode: "RECONNECT_REQUIRED" },
          ]
        : [{ platform: "x", status: "failed", errorCode: "CONNECTION_GONE" }],
    );

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect(resultFindManyMock).toHaveBeenCalledWith({
      where: { postJobId: "feed-1", status: "failed" },
      select: { platform: true, status: true, errorCode: true },
    });
    expect(result.connectionSteps.get("feed-1")).toEqual(["connect", "reconnect"]);
    expect(result.connectionSteps.get("story-1")).toEqual(["connect"]);
  });

  it("dispatchNow: rows that can't be read leave the steps unknown", async () => {
    prepareMock.mockReset();
    prepareMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });
    resultFindManyMock.mockReset();
    resultFindManyMock.mockRejectedValue(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchNow(["feed-1"], { route: "test" });

    expect(result.notSent.has("feed-1")).toBe(true);
    expect(result.connectionSteps.has("feed-1")).toBe(false);
  });

  it("dispatchNow keeps the platform of the first failed result with its sentence", async () => {
    prepareMock.mockReset();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ids: [] });
    resultFindFirstMock.mockReset();
    resultFindFirstMock.mockResolvedValue({ errorMessage: "Reconnect Facebook Page in Settings, then retry.", platform: "facebook_page" });
    prepareMock.mockImplementation(async (id: string) =>
      id === "story-1"
        ? { ok: false, reason: "NO_CONNECTIONS" }
        : { ok: true, event: { postJobId: id, userId: "u", workspaceId: "ws", mediaItemId: null, baseCaption: "c", perPlatformOverrides: null } },
    );

    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });

    expect(result.whyNotSent.get("story-1")).toEqual({
      errorMessage: "Reconnect Facebook Page in Settings, then retry.",
      platform: "facebook_page",
    });
    expect(resultFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ select: { errorMessage: true, platform: true } }),
    );
  });
});

// R29 publishing L1 + L2: each claimed post's own state after a failed start.
describe("dispatchNow - which posts were left unmarked", () => {
  const ok = (id: string) => ({
    ok: true,
    event: { postJobId: id, userId: "u", workspaceId: "ws", mediaItemId: null, baseCaption: "c", perPlatformOverrides: null },
  });
  beforeEach(() => {
    prepareMock.mockReset();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ids: [] });
    failPendingMock.mockReset();
    failPendingMock.mockResolvedValue({ failedCount: 0, unconfirmedCount: 0, status: "failed" });
    withdrawSendMock.mockReset();
    withdrawSendMock.mockResolvedValue(undefined);
    resultCountMock.mockReset();
    resultCountMock.mockResolvedValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prepare throws and only the Story's marking fails: only the Story is unmarked", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    failPendingMock.mockImplementation(async (id: string) => {
      if (id === "story-1") throw new Error("db blip");
      return { failedCount: 0, unconfirmedCount: 0, status: "failed" };
    });
    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });
    expect([...result.unmarked]).toEqual(["story-1"]);
    expect(result.resultsMarked).toBe(false);
  });

  it("the hand-over fails and one marking fails: that one is unmarked", async () => {
    prepareMock.mockImplementation(async (id: string) => ok(id));
    sendMock.mockRejectedValue(new Error("inngest down"));
    failPendingMock.mockImplementation(async (id: string) => {
      if (id === "feed-1") throw new Error("db blip");
      return { failedCount: 1, unconfirmedCount: 0, status: "failed" };
    });
    const result = await dispatchNow(["feed-1", "story-1"], { route: "test" });
    expect([...result.unmarked]).toEqual(["feed-1"]);
  });

  it("all marked: none unmarked", async () => {
    prepareMock.mockRejectedValue(new Error("pool timeout"));
    const result = await dispatchNow(["feed-1"], { route: "test" });
    expect(result.unmarked.size).toBe(0);
  });
});

describe("failedStartAnswer", () => {
  const dispatch = (over: { unmarked?: string[]; withoutResults?: string[]; notSent?: string[] } = {}) => ({
    sent: new Set<string>(),
    notSent: new Set(over.notSent ?? []),
    reasons: new Map(),
    connectionSteps: new Map(),
    whyNotSent: new Map(),
    limitRefusals: new Map(),
    sendFailed: true,
    resultsMarked: (over.unmarked ?? []).length === 0,
    unmarked: new Set(over.unmarked ?? []),
    withoutResults: new Set(over.withoutResults ?? []),
  });
  const story = { id: "story-1", kind: "story" as const, changed: true, note: "Its Story is publishing too." };

  it("a post alone: its own state, no otherHalf", () => {
    expect(failedStartAnswer("feed-1", null, dispatch({ unmarked: ["feed-1"], withoutResults: ["feed-1"] }))).toEqual({
      body: { resultsMarked: false, withoutResults: true },
    });
    expect(failedStartAnswer("feed-1", null, dispatch())).toEqual({ body: { resultsMarked: true } });
  });

  it("the feed post has results, the Story has none: the Story is told to press Send again", () => {
    const answer = failedStartAnswer("feed-1", story, dispatch({ withoutResults: ["story-1"] }));
    expect(answer.body).toEqual({
      resultsMarked: true,
      otherHalf: { ...story, note: "Its Story was not sent: press Send again on its card in Activity." },
    });
    expect(answer.halfNote).toBe("Its Story was not sent: press Send again on its card in Activity.");
    expect(answer.halfMayHaveStarted).toBe(false);
  });

  it("pressed on the Story, the feed post left unmarked: it may have started", () => {
    const feed = { id: "feed-1", kind: "feed" as const, changed: true, note: "Its feed post is publishing too." };
    const answer = failedStartAnswer("story-1", feed, dispatch({ withoutResults: ["feed-1"], unmarked: ["feed-1"] }));
    expect(answer.body.resultsMarked).toBe(true);
    expect(answer.body.otherHalf?.note).toBe(
      "Its feed post may not have started: check its card in Activity; it can show as publishing for about two hours, sometimes a little longer, before it shows what to do next.",
    );
    expect(answer.halfMayHaveStarted).toBe(true);
  });

  it("a half left alone, or one with no connected platform, keeps its note", () => {
    const leftAlone = { ...story, changed: false, note: "Its Story is already publishing, so it was not published." };
    expect(failedStartAnswer("feed-1", leftAlone, dispatch()).body.otherHalf).toEqual(leftAlone);
    expect(failedStartAnswer("feed-1", leftAlone, dispatch()).halfNote).toBeUndefined();
    const notSent = { ...story, note: "Its Story was not sent: each of its platforms is either not connected or needs reconnecting." };
    expect(failedStartAnswer("feed-1", notSent, dispatch({ notSent: ["story-1"] })).body.otherHalf).toEqual(notSent);
  });
});
