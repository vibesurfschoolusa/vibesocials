import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. Only the Prisma methods the helper
// touches are mocked; `recomputePostJobStatus` stays REAL so the job status
// asserted below is the one the publish pipeline itself would compute.
//
// The status recompute runs inside `prisma.$transaction` (2026-11-01 scale
// audit, jobs H6): the bare client has ONLY the claimed/unclaimed `updateMany`
// writes, while the result read, the status write and the row lock live on the
// `tx` the transaction hands out - so a read or write that bypassed the
// transaction would throw here instead of passing.
const { resultUpdateManyMock, resultFindManyMock, postJobUpdateMock, executeRawMock, transactionMock } =
  vi.hoisted(() => ({
    resultUpdateManyMock: vi.fn(),
    resultFindManyMock: vi.fn(),
    postJobUpdateMock: vi.fn(),
    executeRawMock: vi.fn(),
    transactionMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { updateMany: resultUpdateManyMock },
    $transaction: transactionMock,
  },
}));

import {
  DISPATCH_FAILURE,
  PUBLISH_UNCONFIRMED,
  failPendingPostJobResults,
  recomputeAndStorePostJobStatus,
} from "./failPendingResults";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

/** The transaction client `$transaction` hands to its callback. */
const tx = {
  $executeRaw: executeRawMock,
  postJobResult: { findMany: resultFindManyMock },
  postJob: { update: postJobUpdateMock },
};

beforeEach(() => {
  resultUpdateManyMock.mockReset();
  resultFindManyMock.mockReset();
  postJobUpdateMock.mockReset();
  executeRawMock.mockReset();
  transactionMock.mockReset();

  resultUpdateManyMock.mockResolvedValue({ count: 2 });
  resultFindManyMock.mockResolvedValue([{ status: "failed" }, { status: "failed" }]);
  postJobUpdateMock.mockResolvedValue({});
  executeRawMock.mockResolvedValue(1);
  transactionMock.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx));
});

describe("DISPATCH_FAILURE", () => {
  it("is the exact code + message the routes return and store", () => {
    expect(DISPATCH_FAILURE).toEqual({
      errorCode: "DISPATCH_FAILED",
      errorMessage: "Couldn't start publishing. Please try again.",
    });
  });
});

describe("PUBLISH_UNCONFIRMED", () => {
  it("is built from the shared publishOutcomes code + message", () => {
    expect(PUBLISH_UNCONFIRMED).toEqual({
      errorCode: PUBLISH_UNCONFIRMED_CODE,
      errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
    });
    expect(PUBLISH_UNCONFIRMED_CODE).toBe("PUBLISH_UNCONFIRMED");
  });
});

describe("failPendingPostJobResults", () => {
  it("fails only the job's still-pending UNCLAIMED results, with the given code + message", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "DISPATCH_FAILED",
        errorMessage: "Couldn't start publishing. Please try again.",
      },
    });
  });

  it("is parameterized — any code/message (e.g. an interrupted run) is written as given", async () => {
    await failPendingPostJobResults("job-9", {
      errorCode: "PUBLISH_INTERRUPTED",
      errorMessage: "Publishing was interrupted. Please retry.",
    });

    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-9", status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "PUBLISH_INTERRUPTED",
        errorMessage: "Publishing was interrupted. Please retry.",
      },
    });
  });

  it("recomputes the job status over ALL its results after the update", async () => {
    resultUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 2 });
    resultFindManyMock.mockResolvedValue([{ status: "failed" }, { status: "failed" }]);

    const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    // Read AFTER the write, so the recompute sees the freshly failed rows.
    expect(resultFindManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1" },
      select: { status: true },
    });
    expect(resultUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      resultFindManyMock.mock.invocationCallOrder[0],
    );
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(outcome).toEqual({ failedCount: 2, unconfirmedCount: 0, status: "failed" });
  });

  it("keeps a partial success completed (a platform that already went live stays live)", async () => {
    resultUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    resultFindManyMock.mockResolvedValue([{ status: "success" }, { status: "failed" }]);

    const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "completed" },
    });
    expect(outcome).toEqual({ failedCount: 1, unconfirmedCount: 0, status: "completed" });
  });

  // Task 4 fix round 1 (ruling R8b): a retry run that dies may only fail the
  // platforms IT re-queued — another run of the same job may still own the rest.
  it("with a platforms filter, fails only those platforms' pending results", async () => {
    await failPendingPostJobResults(
      "job-1",
      { errorCode: "PUBLISH_INTERRUPTED", errorMessage: "Publishing was interrupted. Please retry." },
      { platforms: ["x", "tiktok"] },
    );

    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: {
        postJobId: "job-1",
        status: "pending",
        claimRunId: null,
        platform: { in: ["x", "tiktok"] },
      },
      data: {
        status: "failed",
        errorCode: "PUBLISH_INTERRUPTED",
        errorMessage: "Publishing was interrupted. Please retry.",
      },
    });
    // ...and the claimed rows of those platforms only.
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: {
        postJobId: "job-1",
        status: "pending",
        claimRunId: { not: null },
        platform: { in: ["x", "tiktok"] },
      },
      data: {
        status: "failed",
        errorCode: "PUBLISH_UNCONFIRMED",
        errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
      },
    });
  });

  it("with a platforms filter, still recomputes the job over ALL its results", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "failed" }, { status: "pending" }]);

    const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE, { platforms: ["x"] });

    expect(resultFindManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1" },
      select: { status: true },
    });
    // The other run's still-pending platform keeps the job in_progress.
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "in_progress" },
    });
    expect(outcome.status).toBe("in_progress");
  });

  it("without the option (every existing caller), does not filter by platform", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE, {});

    for (const [arg] of resultUpdateManyMock.mock.calls) {
      expect(arg.where).not.toHaveProperty("platform");
    }
  });

  it("never leaves an empty fan-out in_progress (no results → failed)", async () => {
    resultUpdateManyMock.mockResolvedValue({ count: 0 });
    resultFindManyMock.mockResolvedValue([]);

    const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(outcome.status).toBe("failed");
  });

  // 2026-11-01 scale audit (jobs H6): a result whose platform step has CLAIMED it
  // may be mid-call to the platform. Failing it with the caller's reason ("please
  // retry") would invite a second post of something that may already be live, so
  // claimed rows are marked PUBLISH_UNCONFIRMED instead and only unclaimed rows
  // - provably never sent - get the caller's failure.
  describe("claimed and unclaimed results", () => {
    it("marks claimed pending rows PUBLISH_UNCONFIRMED first, then fails the unclaimed ones with the caller's reason", async () => {
      resultUpdateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 2 });

      await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

      expect(resultUpdateManyMock).toHaveBeenCalledTimes(2);
      expect(resultUpdateManyMock).toHaveBeenNthCalledWith(1, {
        where: { postJobId: "job-1", status: "pending", claimRunId: { not: null } },
        data: {
          status: "failed",
          errorCode: "PUBLISH_UNCONFIRMED",
          errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
        },
      });
      expect(resultUpdateManyMock).toHaveBeenNthCalledWith(2, {
        where: { postJobId: "job-1", status: "pending", claimRunId: null },
        data: {
          status: "failed",
          errorCode: "DISPATCH_FAILED",
          errorMessage: "Couldn't start publishing. Please try again.",
        },
      });
    });

    it("returns both counts", async () => {
      resultUpdateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 2 });
      resultFindManyMock.mockResolvedValue([
        { status: "failed" },
        { status: "failed" },
        { status: "failed" },
      ]);

      const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

      expect(outcome).toEqual({ failedCount: 2, unconfirmedCount: 1, status: "failed" });
    });

    it("recomputes the job only after both writes", async () => {
      await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

      expect(resultUpdateManyMock.mock.invocationCallOrder[1]).toBeLessThan(
        resultFindManyMock.mock.invocationCallOrder[0],
      );
    });
  });
});

// 2026-11-01 scale audit (jobs H6 + M4): the retry function no longer
// serializes per postJobId, so two runs of one job can finalize at once. Each
// recompute reads every result and then writes the job's status; unserialized, a
// finalizer holding a STALE read could write `in_progress` after the other wrote
// `completed`, leaving the job stuck until the 2 h reconciler. The recompute
// therefore takes the PostJob row lock first.
describe("recomputeAndStorePostJobStatus", () => {
  it("runs inside a transaction whose first statement locks the PostJob row", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }, { status: "failed" }]);

    await recomputeAndStorePostJobStatus("job-1");

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRawMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toBe('SELECT 1 FROM "PostJob" WHERE "id" = ? FOR UPDATE');
    expect(values).toEqual(["job-1"]);
    // Lock -> read -> write, in that order, all on the transaction client.
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      resultFindManyMock.mock.invocationCallOrder[0],
    );
    expect(resultFindManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      postJobUpdateMock.mock.invocationCallOrder[0],
    );
  });

  it("returns the recomputed status and the number of successful results", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }, { status: "failed" }]);

    const outcome = await recomputeAndStorePostJobStatus("job-1");

    expect(outcome).toEqual({ status: "completed", successCount: 1 });
    expect(resultFindManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1" },
      select: { status: true },
    });
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "completed" },
    });
  });

  it.each([
    ["a pending result keeps the job in_progress", [{ status: "success" }, { status: "pending" }], "in_progress", 1],
    ["only failures fail the job", [{ status: "failed" }, { status: "failed" }], "failed", 0],
    ["no results fail the job", [], "failed", 0],
  ] as const)("%s", async (_label, results, status, successCount) => {
    resultFindManyMock.mockResolvedValue([...results]);

    expect(await recomputeAndStorePostJobStatus("job-1")).toEqual({ status, successCount });
  });

  it("propagates a failure so the DB-only finalize step is retried", async () => {
    postJobUpdateMock.mockRejectedValue(new Error("Timed out fetching a new connection from the pool"));

    await expect(recomputeAndStorePostJobStatus("job-1")).rejects.toThrow(/pool/);
  });

  // Review Focus 4. The mock models a row lock the way Postgres does: the
  // `FOR UPDATE` statement WAITS while another transaction holds it, and the lock
  // is released when that transaction ends. Result rows are written outside the
  // lock (a platform step's finalizeClaimedResult), so finalizer A can read, then
  // a platform step lands, then finalizer B runs.
  describe("two finalizers racing (Review Focus 4)", () => {
    type Gate = { promise: Promise<void>; open: () => void };
    function gate(): Gate {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }

    it("serializes them on the row lock, so the job ends completed - not in_progress", async () => {
      // Job z already succeeded; retry runs R1 and R2 re-queued x and y.
      const rows: Record<string, string> = { z: "success", x: "pending", y: "pending" };
      const stored: string[] = [];

      let lockTail: Promise<void> = Promise.resolve();
      const lockAcquiredBy: number[] = [];
      let transactions = 0;
      const firstReadTaken = gate();
      const afterFirstRead = gate();
      let reads = 0;

      transactionMock.mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => {
        const id = ++transactions;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const client = {
          // SELECT ... FOR UPDATE: wait for the previous holder, hold until this tx ends.
          $executeRaw: async () => {
            const previous = lockTail;
            lockTail = previous.then(() => held);
            await previous;
            lockAcquiredBy.push(id);
            return 1;
          },
          postJobResult: {
            findMany: async () => {
              const snapshot = Object.values(rows).map((status) => ({ status }));
              // The FIRST read is slow: its snapshot is taken now, but the
              // transaction carries on only after a platform step has landed.
              if (++reads === 1) {
                firstReadTaken.open();
                await afterFirstRead.promise;
              }
              return snapshot;
            },
          },
          postJob: {
            update: async ({ data }: { data: { status: string } }) => {
              stored.push(data.status);
              return {};
            },
          },
        };
        try {
          return await callback(client);
        } finally {
          release();
        }
      });

      // R1 finalizes after its platform (x) finished; y is still pending.
      rows.x = "success";
      const first = recomputeAndStorePostJobStatus("job-1");
      // R2 starts finalizing while R1 holds the lock...
      const second = recomputeAndStorePostJobStatus("job-1");
      // ...R2's platform step (y) lands once R1 has read, then R1's slow read returns.
      await firstReadTaken.promise;
      rows.y = "success";
      afterFirstRead.open();

      const [a, b] = await Promise.all([first, second]);

      // The job's LAST stored status is its final one: completed, never the stale
      // in_progress of R1's early read.
      expect(stored.at(-1)).toBe("completed");
      // R1's read predates y, so it stored in_progress; R2 ran strictly after R1
      // committed, re-read, and stored the final status LAST.
      expect(stored).toEqual(["in_progress", "completed"]);
      expect(a).toEqual({ status: "in_progress", successCount: 2 });
      expect(b).toEqual({ status: "completed", successCount: 3 });
      expect(lockAcquiredBy).toEqual([1, 2]);
    });
  });
});

describe("failPendingPostJobResults - status recompute", () => {
  it("writes the result rows first, then recomputes the job's status under the row lock", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    // The row writes are not part of the transaction: the lock is held only for
    // the short read + write, never while result rows are locked.
    expect(resultUpdateManyMock.mock.invocationCallOrder[1]).toBeLessThan(
      transactionMock.mock.invocationCallOrder[0],
    );
    expect(transactionMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeRawMock.mock.invocationCallOrder[0],
    );
  });
});
