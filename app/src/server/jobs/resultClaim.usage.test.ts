import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
  createMany: vi.fn(),
  txCreateMany: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { update: m.update, findUnique: m.findUnique },
    usageEvent: { createMany: m.createMany },
    $transaction: async (callback: (tx: unknown) => unknown) => {
      m.calls.push("transaction");
      return callback({ postJobResult: { update: m.update }, usageEvent: { createMany: m.txCreateMany } });
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
  for (const fn of [m.update, m.findUnique, m.createMany, m.txCreateMany]) fn.mockReset();
  m.calls = [];
  m.update.mockImplementation(async () => {
    m.calls.push("result");
    return {};
  });
  m.txCreateMany.mockImplementation(async () => {
    m.calls.push("usage");
    return { count: 1 };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalizeClaimedResult with an X post's usage", () => {
  it("writes the success and the usage row in one transaction, the row once per result", async () => {
    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" }, USAGE),
    ).resolves.toBe(true);
    expect(m.calls).toEqual(["transaction", "result", "usage"]);
    expect(m.txCreateMany).toHaveBeenCalledWith({ data: [ROW], skipDuplicates: true });
  });

  it("writes no usage for a failure, and no transaction without usage", async () => {
    await finalizeClaimedResult("r1", "run-1", { status: "failed", errorCode: "E", errorMessage: "e" }, USAGE);
    await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" });
    expect(m.calls).toEqual(["result", "result"]);
    expect(m.txCreateMany).not.toHaveBeenCalled();
  });

  it("still counts a post that is live when its result could not be recorded (claim lost)", async () => {
    m.update.mockRejectedValue(Object.assign(new Error("No record"), { code: "P2025" }));
    m.findUnique.mockResolvedValue(null);
    m.createMany.mockResolvedValue({ count: 1 });

    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "tw-1" }, USAGE),
    ).resolves.toBe(false);
    expect(m.createMany).toHaveBeenCalledWith({ data: [ROW], skipDuplicates: true });
  });
});
