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

import { logger } from "@/lib/logger";

import { claimResult, finalizeClaimedResult, releaseClaimForDeferral } from "./resultClaim";

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
      // Taking the claim also clears a deferral (the wait is over) and the
      // RATE_LIMITED / DAILY_LIMIT code it carried.
      data: {
        claimRunId: "run-1",
        claimedAt: NOW,
        deferredUntil: null,
        errorCode: null,
        errorMessage: null,
      },
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

  // R17: a confirmed success wins over ANY failure written while this run still
  // holds the claim - the reconciler's / onFailure's PUBLISH_UNCONFIRMED (U7: a
  // timed-out invocation can keep running), the retry route's enqueue-failure
  // revert, or old code reverting rows during version skew. A new attempt has to
  // clear or take the claim before it can act, so the claim is the guard.
  it("lets a confirmed success replace a failure written while this run still holds the claim", async () => {
    updateMock.mockResolvedValue({});

    const wrote = await finalizeClaimedResult("r1", "run-1", {
      status: "success",
      externalPostId: "ext-1",
    });

    expect(wrote).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "r1", claimRunId: "run-1", status: { in: ["pending", "failed"] } },
      data: { status: "success", externalPostId: "ext-1", ...HEARTBEAT },
    });
  });

  describe("against a stored row (the where is evaluated, not just compared)", () => {
    type Row = { id: string; status: string; errorCode: string | null; claimRunId: string | null };
    let row: Row;

    function p2025() {
      return new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "test",
      });
    }

    beforeEach(() => {
      updateMock.mockImplementation(
        async ({
          where,
          data,
        }: {
          where: { id: string; claimRunId: string; status: string | { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
          if (where.id !== row.id || where.claimRunId !== row.claimRunId || !allowed.includes(row.status)) {
            throw p2025();
          }
          Object.assign(row, { ...data, postJob: undefined });
          return {};
        },
      );
    });

    it.each([
      ["the retry route's enqueue-failure revert", "RETRY_ENQUEUE_FAILED"],
      ["a PUBLISH_UNCONFIRMED mark", "PUBLISH_UNCONFIRMED"],
      ["a PUBLISH_INTERRUPTED mark", "PUBLISH_INTERRUPTED"],
    ])("a row reverted to failed by %s, still claimed by run-1, is overwritten with run-1's success", async (_label, errorCode) => {
      row = { id: "r1", status: "failed", errorCode, claimRunId: "run-1" };

      const wrote = await finalizeClaimedResult("r1", "run-1", {
        status: "success",
        externalPostId: "ext-1",
      });

      expect(wrote).toBe(true);
      expect(row).toMatchObject({ status: "success", claimRunId: "run-1" });
    });

    it("another run's success does not overwrite it (the claim is what guards)", async () => {
      row = { id: "r1", status: "failed", errorCode: "RETRY_ENQUEUE_FAILED", claimRunId: "run-1" };

      const wrote = await finalizeClaimedResult("r1", "run-2", {
        status: "success",
        externalPostId: "ext-2",
      });

      expect(wrote).toBe(false);
      expect(row.status).toBe("failed");
    });

    it("a row whose claim was cleared (a new retry took over) is not overwritten", async () => {
      row = { id: "r1", status: "pending", errorCode: null, claimRunId: null };

      const wrote = await finalizeClaimedResult("r1", "run-1", {
        status: "success",
        externalPostId: "ext-1",
      });

      expect(wrote).toBe(false);
      expect(row.status).toBe("pending");
    });

    it("a failure still needs the row to be pending: it never overwrites a failed or successful row", async () => {
      for (const status of ["failed", "success"]) {
        row = { id: "r1", status, errorCode: "PUBLISH_UNCONFIRMED", claimRunId: "run-1" };

        const wrote = await finalizeClaimedResult("r1", "run-1", {
          status: "failed",
          errorCode: "X_TWEET_FAILED",
          errorMessage: "nope",
        });

        expect(wrote).toBe(false);
        expect(row.status).toBe(status);
      }
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

  it("returns false and logs a warning (without throwing) when a failure's claim is no longer held (P2025)", async () => {
    updateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const wrote = await finalizeClaimedResult("r1", "run-1", {
      status: "failed",
      errorCode: "X_TWEET_FAILED",
      errorMessage: "nope",
    });

    expect(wrote).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  // Final review F6 (M1): a success write that finds the claim gone means the post
  // IS live but the row says otherwise (for example PUBLISH_UNCONFIRMED). The log
  // line is the only trace to reconcile it by, so it is an ERROR and it carries
  // the provider's post id (plus platform and ids). Never tokens or emails.
  describe("a lost success write (the post is live, the row does not say so)", () => {
    const p2025 = () =>
      new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "test",
      });

    beforeEach(() => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      updateMock.mockRejectedValue(p2025());
      findUniqueMock.mockResolvedValue({ platform: "x", postJobId: "job-1", status: "failed" });
    });

    it("returns false without throwing", async () => {
      const wrote = await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-1" });

      expect(wrote).toBe(false);
    });

    it("logs at error level with the externalPostId, platform, result id and run id", async () => {
      await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-1" });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("no longer holds its claim"),
        expect.objectContaining({
          externalPostId: "ext-1",
          platform: "x",
          resultId: "r1",
          postJobId: "job-1",
          runId: "run-1",
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("still logs the externalPostId at error level when the platform lookup itself fails", async () => {
      findUniqueMock.mockRejectedValue(new Error("connection reset"));

      const wrote = await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-9" });

      expect(wrote).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ externalPostId: "ext-9", resultId: "r1", runId: "run-1" }),
      );
    });

    it("logs a success with no provider id (null) too", async () => {
      await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: null });

      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ externalPostId: null, resultId: "r1" }),
      );
    });

    it("never logs tokens or email addresses", async () => {
      await finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-1" });

      const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
      expect(logged).not.toMatch(/token|secret|password|@/i);
    });

    it("a failure that loses its claim stays a warning, not an error", async () => {
      await finalizeClaimedResult("r1", "run-1", {
        status: "failed",
        errorCode: "X_TWEET_FAILED",
        errorMessage: "nope",
      });

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(findUniqueMock).not.toHaveBeenCalled();
    });
  });

  it("rethrows any other database error", async () => {
    updateMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      finalizeClaimedResult("r1", "run-1", { status: "success", externalPostId: "ext-1" }),
    ).rejects.toThrow("connection reset");
  });
});

// 2026-11-01 scale audit (platform limits): a rate-limited platform step does not
// fail its result, it hands the claim back and lets the run sleep. The result
// stays `pending`, holds no claim and records until when it waits.
describe("releaseClaimForDeferral", () => {
  const HEARTBEAT = { postJob: { update: { updatedAt: expect.any(Date) } } };
  const until = new Date("2026-11-02T20:00:00.000Z");

  function p2025() {
    return new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
      code: "P2025",
      clientVersion: "test",
    });
  }

  it("releases the claim and records the deferral, only while this run holds the claim on a pending result", async () => {
    updateMock.mockResolvedValue({});

    const released = await releaseClaimForDeferral("r1", "run-1", { until, errorCode: "RATE_LIMITED" });

    expect(released).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "r1", claimRunId: "run-1", status: "pending" },
      data: {
        claimRunId: null,
        claimedAt: null,
        deferredUntil: until,
        errorCode: "RATE_LIMITED",
        errorMessage: null,
        ...HEARTBEAT,
      },
    });
  });

  it("records DAILY_LIMIT for a daily limit", async () => {
    updateMock.mockResolvedValue({});

    await releaseClaimForDeferral("r1", "run-1", { until, errorCode: "DAILY_LIMIT" });

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: "DAILY_LIMIT" }) }),
    );
  });

  it("returns false and logs a warning (without throwing) when the claim is no longer held (P2025)", async () => {
    updateMock.mockRejectedValue(p2025());

    const released = await releaseClaimForDeferral("r1", "run-1", { until, errorCode: "RATE_LIMITED" });

    expect(released).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("rethrows any other database error", async () => {
    updateMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      releaseClaimForDeferral("r1", "run-1", { until, errorCode: "RATE_LIMITED" }),
    ).rejects.toThrow("connection reset");
  });

  it("a released result can be claimed again, which ends the deferral", async () => {
    // The release leaves the row pending with no claim holder; claimResult's
    // conditional write matches exactly that and clears the deferral.
    updateManyMock.mockResolvedValue({ count: 1 });

    expect(await claimResult("r1", "run-1", NOW)).toBe("claimed");
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", status: "pending", claimRunId: null },
        data: expect.objectContaining({ deferredUntil: null }),
      }),
    );
  });
});
