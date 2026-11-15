import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
  createMany: vi.fn(),
  transaction: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { update: m.update, findUnique: m.findUnique },
    usageEvent: { createMany: m.createMany },
    // Second review: a batch (an array of queries), never an interactive transaction.
    $transaction: async (queries: unknown) => {
      if (!Array.isArray(queries)) throw new Error("interactive transaction");
      m.calls.push("transaction");
      return m.transaction(queries);
    },
  },
}));

import { finalizeClaimedResult } from "./resultClaim";

/**
 * R5-security M1 (review): an X post counts for its X account from the moment
 * it publishes, written with the result, so a later disconnect, deletion or
 * reconnect elsewhere cannot lose it.
 */

const USAGE = { userId: "user-1", workspaceId: "ws-1", accountId: "x-account-7" };
const ROW = {
  kind: "x_post",
  userId: "user-1",
  workspaceId: "ws-1",
  platform: "x",
  accountId: "x-account-7",
  sourceId: "r1",
  at: expect.any(Date),
};

beforeEach(() => {
  for (const fn of [m.update, m.findUnique, m.createMany, m.transaction]) fn.mockReset();
  m.calls = [];
  // The batch's queries are built (not run) by the model calls, then run together.
  m.update.mockImplementation((args: unknown) => {
    m.calls.push("result");
    return Promise.resolve(args);
  });
  m.createMany.mockImplementation((args: unknown) => {
    m.calls.push("usage");
    return Promise.resolve({ count: 1, args });
  });
  m.transaction.mockImplementation(async (queries: Promise<unknown>[]) => Promise.all(queries));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalizeClaimedResult with an X post's usage", () => {
  it("writes the success and the usage row in one batch transaction, the row once per result", async () => {
    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" }, USAGE),
    ).resolves.toBe(true);
    expect(m.calls).toEqual(["result", "usage", "transaction"]);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.createMany).toHaveBeenCalledWith({ data: [ROW], skipDuplicates: true });
  });

  // Second review: a busy pool or a failed usage write must not turn a live
  // post into PUBLISH_UNCONFIRMED: the success is written on its own.
  it("when the batch fails for another reason, still records the success, never as unconfirmed", async () => {
    m.transaction.mockRejectedValueOnce(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }));

    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" }, USAGE),
    ).resolves.toBe(true);

    const writes = m.update.mock.calls.map(([args]) => (args as { data: { status: string; errorCode?: string } }).data);
    expect(writes.at(-1)).toMatchObject({ status: "success", externalPostId: "tw-1" });
    expect(writes.some((data) => data.errorCode === "PUBLISH_UNCONFIRMED")).toBe(false);
    // The usage row is tried again on its own.
    expect(m.createMany.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("writes no usage for a failure, and no transaction without usage", async () => {
    await finalizeClaimedResult("r1", "run-1", { status: "failed", errorCode: "E", errorMessage: "e" }, USAGE);
    await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" });
    expect(m.calls).toEqual(["result", "result"]);
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.createMany).not.toHaveBeenCalled();
  });

  it("still counts a post that is live when its result could not be recorded (claim lost)", async () => {
    m.transaction.mockRejectedValue(Object.assign(new Error("No record"), { code: "P2025" }));
    m.findUnique.mockResolvedValue(null);

    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" }, USAGE),
    ).resolves.toBe(false);
    expect(m.createMany).toHaveBeenCalledWith({ data: [ROW], skipDuplicates: true });
  });
});
