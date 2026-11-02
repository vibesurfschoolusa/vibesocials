import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. Only the three PostJobResult methods the
// claim helpers touch are mocked; nothing here reaches a database.
const { updateManyMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: {
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

import { claimResult, finalizeClaimedResult } from "./resultClaim";

const NOW = new Date("2026-11-02T10:00:00.000Z");

beforeEach(() => {
  updateManyMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 2026-11-01 scale audit (jobs H6): a platform step claims its result row with
// ONE conditional write before it calls the platform, so two runs of one job
// (a duplicate event, a retry overlapping a late original) can never both call
// the same platform.
describe("claimResult", () => {
  it("issues one conditional updateMany (pending and unclaimed) and returns claimed on count 1", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const outcome = await claimResult("r1", "run-1", NOW);

    expect(outcome).toBe("claimed");
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "r1", status: "pending", claimRunId: null },
      data: { claimRunId: "run-1", claimedAt: NOW },
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("stamps claimedAt with the current time when no clock is passed", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await claimResult("r1", "run-1");

    const { data } = updateManyMock.mock.calls[0][0] as { data: { claimedAt: unknown } };
    expect(data.claimedAt).toBeInstanceOf(Date);
  });

  describe("when the conditional write matched nothing", () => {
    beforeEach(() => {
      updateManyMock.mockResolvedValue({ count: 0 });
    });

    it.each([
      ["the result already finished", { status: "success", claimRunId: "run-2" }, "not_pending"],
      ["the result already failed", { status: "failed", claimRunId: null }, "not_pending"],
      ["the result no longer exists", null, "not_pending"],
      ["another run holds the claim", { status: "pending", claimRunId: "run-2" }, "held_by_other_run"],
      ["this very run holds the claim", { status: "pending", claimRunId: "run-1" }, "held_by_this_run"],
    ])("reads the row back: %s", async (_label, row, expected) => {
      findUniqueMock.mockResolvedValue(row);

      const outcome = await claimResult("r1", "run-1", NOW);

      expect(outcome).toBe(expected);
      expect(findUniqueMock).toHaveBeenCalledWith({
        where: { id: "r1" },
        select: { status: true, claimRunId: true },
      });
    });

    it("treats a pending row with no claim holder (a retry just re-queued it) as held by another run", async () => {
      findUniqueMock.mockResolvedValue({ status: "pending", claimRunId: null });

      expect(await claimResult("r1", "run-1", NOW)).toBe("held_by_other_run");
    });
  });
});

describe("finalizeClaimedResult", () => {
  const HEARTBEAT = { postJob: { update: { updatedAt: expect.any(Date) } } };

  it("writes a failure only while this run still holds the claim on a pending result", async () => {
    updateMock.mockResolvedValue({});

    const wrote = await finalizeClaimedResult("r1", "run-1", {
      status: "failed",
      errorCode: "X_TWEET_FAILED",
      errorMessage: "nope",
    });

    expect(wrote).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "r1", claimRunId: "run-1", status: "pending" },
      data: {
        status: "failed",
        errorCode: "X_TWEET_FAILED",
        errorMessage: "nope",
        ...HEARTBEAT,
      },
    });
  });

  // U7: a timed-out invocation may keep running after the reconciler marked its
  // result PUBLISH_UNCONFIRMED. Once the platform confirms the post, the truth
  // replaces the "couldn't confirm" mark - but only for the run that made it.
  it("lets a confirmed success replace this run's own PUBLISH_UNCONFIRMED mark", async () => {
    updateMock.mockResolvedValue({});

    const wrote = await finalizeClaimedResult("r1", "run-1", {
      status: "success",
      externalPostId: "ext-1",
    });

    expect(wrote).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      where: {
        id: "r1",
        claimRunId: "run-1",
        OR: [{ status: "pending" }, { status: "failed", errorCode: "PUBLISH_UNCONFIRMED" }],
      },
      data: { status: "success", externalPostId: "ext-1", ...HEARTBEAT },
    });
  });

  it("writes a null externalPostId through unchanged", async () => {
    updateMock.mockResolvedValue({});

    await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: null });

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "success", externalPostId: null, ...HEARTBEAT },
      }),
    );
  });

  it("returns false and logs a warning (without throwing) when the claim is no longer held (P2025)", async () => {
    updateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const wrote = await finalizeClaimedResult("r1", "run-1", {
      status: "success",
      externalPostId: "ext-1",
    });

    expect(wrote).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("rethrows any other database error", async () => {
    updateMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-1" }),
    ).rejects.toThrow("connection reset");
  });
});
