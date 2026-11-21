import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. Only the Prisma methods the helper
// touches are mocked; `recomputePostJobStatus` stays REAL so the job status
// asserted below is the one the publish pipeline itself would compute.
//
// The status recompute runs inside `prisma.$transaction` (2026-11-01 scale
// audit, jobs H6), and since KK4 so do failPendingPostJobResults' row writes:
// the bare client has no result writes at all, while the writes, the result
// read, the status write and the row lock live on the `tx` the transaction
// hands out - so a read or write that bypassed the transaction would throw
// here instead of passing.
const {
  resultUpdateManyMock,
  resultFindManyMock,
  postJobUpdateMock,
  postJobFindUniqueMock,
  mediaUpdateManyMock,
  executeRawMock,
  transactionMock,
  postJobCountMock,
  queryRawMock,
} = vi.hoisted(() => ({
  resultUpdateManyMock: vi.fn(),
  resultFindManyMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  postJobFindUniqueMock: vi.fn(),
  mediaUpdateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  transactionMock: vi.fn(),
  postJobCountMock: vi.fn(),
  queryRawMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transactionMock,
  },
}));

/** A client for finishPostJob: its conditional write, then the media stamp. */
const finishDb = {
  postJob: { updateMany: vi.fn(), findUnique: vi.fn() },
  mediaItem: { updateMany: vi.fn() },
};

import {
  connectionGoneFailure,
  PUBLISH_STALLED_FAILURE,
  DISPATCH_FAILURE,
  PUBLISH_UNCONFIRMED,
  RECOMPUTE_TX_MAX_WAIT_MS,
  RECOMPUTE_TX_TIMEOUT_MS,
  failPendingPostJobResults,
  failPendingResultsIfStillStale,
  finishPostJob,
  recomputeAndStorePostJobStatus,
} from "./failPendingResults";
import { isMediaSweepEligible, RETENTION_DAYS } from "./mediaRetention";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

/** The transaction client `$transaction` hands to its callback. */
const tx = {
  $executeRaw: executeRawMock,
  $queryRaw: queryRawMock,
  postJobResult: { findMany: resultFindManyMock, updateMany: resultUpdateManyMock },
  postJob: { update: postJobUpdateMock, findUnique: postJobFindUniqueMock, count: postJobCountMock },
  mediaItem: { updateMany: mediaUpdateManyMock },
};

beforeEach(() => {
  resultUpdateManyMock.mockReset();
  resultFindManyMock.mockReset();
  postJobUpdateMock.mockReset();
  executeRawMock.mockReset();
  transactionMock.mockReset();
  postJobFindUniqueMock.mockReset();
  mediaUpdateManyMock.mockReset();

  resultUpdateManyMock.mockResolvedValue({ count: 2 });
  resultFindManyMock.mockResolvedValue([{ status: "failed" }, { status: "failed" }]);
  postJobUpdateMock.mockResolvedValue({});
  executeRawMock.mockResolvedValue(1);
  postJobFindUniqueMock.mockResolvedValue({ mediaItemId: "media-1", media: [] });
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
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

// R59 publishing-flow L1: a removed connection is connected again, not
// reconnected (Settings shows only Connect), so its row says Connect, in the
// words prepare's CONNECTION_GONE row has (publishFailureText connectionGoneMessage).
describe("connectionGoneFailure", () => {
  it("is CONNECTION_GONE with the platform's Connect sentence", () => {
    expect(connectionGoneFailure("x")).toEqual({
      errorCode: "CONNECTION_GONE",
      errorMessage: "X is no longer connected. Connect it in Settings, then retry.",
    });
  });

  it("fails each platform's unclaimed pending results with its own sentence, and a claimed one stays PUBLISH_UNCONFIRMED", async () => {
    resultFindManyMock.mockResolvedValueOnce([{ platform: "x" }, { platform: "instagram" }]);

    await failPendingPostJobResults("job-1", connectionGoneFailure);

    expect(resultFindManyMock).toHaveBeenNthCalledWith(1, {
      where: { postJobId: "job-1", status: "pending", claimRunId: null },
      select: { platform: true },
      distinct: ["platform"],
    });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: null, platform: "x" },
      data: {
        status: "failed",
        errorCode: "CONNECTION_GONE",
        errorMessage: "X is no longer connected. Connect it in Settings, then retry.",
      },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: null, platform: "instagram" },
      data: {
        status: "failed",
        errorCode: "CONNECTION_GONE",
        errorMessage: "Instagram is no longer connected. Connect it in Settings, then retry.",
      },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: { not: null } },
      data: {
        status: "failed",
        errorCode: PUBLISH_UNCONFIRMED_CODE,
        errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
      },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(3);
  });

  it("counts the failed rows across the platforms", async () => {
    resultFindManyMock.mockResolvedValueOnce([{ platform: "x" }, { platform: "instagram" }]);
    resultUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });

    const outcome = await failPendingPostJobResults("job-1", connectionGoneFailure);

    expect(outcome).toMatchObject({ unconfirmedCount: 0, failedCount: 2 });
  });
});

// R27 MM4: the 6-hour stale sweep closes a job through failPendingPostJobResults
// with the stalled reason, the same code and message the 2-hour reconciler writes.
describe("PUBLISH_STALLED_FAILURE", () => {
  it("is the reconciler's stalled code and message", () => {
    expect(PUBLISH_STALLED_FAILURE).toEqual({
      errorCode: "PUBLISH_STALLED",
      errorMessage: "Publish did not complete (stalled). You can retry this platform.",
    });
  });

  it("an unclaimed pending row becomes stalled; a claimed one PUBLISH_UNCONFIRMED (it may be live)", async () => {
    await failPendingPostJobResults("job-1", PUBLISH_STALLED_FAILURE);
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: null },
      data: { status: "failed", ...PUBLISH_STALLED_FAILURE },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: { not: null } },
      data: { status: "failed", errorCode: PUBLISH_UNCONFIRMED_CODE, errorMessage: PUBLISH_UNCONFIRMED_MESSAGE },
    });
  });
});

// R27 MM4 review: the stale sweep's marking re-checks, under the job's row lock
// and inside the marking transaction, that the job is still stale. A run that
// woke up (claimed a row, or wrote its heartbeat) after the sweep read its
// candidates keeps its rows, and no "may already be live" email goes out.
describe("failPendingResultsIfStillStale", () => {
  const cutoff = new Date("2026-11-02T04:30:00.000Z");
  const jobStillStale = { status: { in: ["pending" as const, "in_progress" as const] }, updatedAt: { lt: cutoff } };
  const run = () => failPendingResultsIfStillStale("job-1", PUBLISH_STALLED_FAILURE, { cutoff, job: jobStillStale });
  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");

  beforeEach(() => {
    postJobCountMock.mockReset();
    queryRawMock.mockReset();
    postJobCountMock.mockResolvedValue(1);
    queryRawMock.mockResolvedValue([{ id: "r1", claimedAt: null, deferredUntil: null }]);
  });

  it("still stale: locks the pending rows, then the job (a platform step's order), re-checks both, then marks and recomputes", async () => {
    const out = await run();

    expect(sqlOf(queryRawMock.mock.calls[0])).toMatch(/FROM "PostJobResult" WHERE "postJobId" = \? AND "status" = 'pending' FOR UPDATE/);
    expect(sqlOf(executeRawMock.mock.calls[0])).toMatch(/FROM "PostJob" WHERE "id" = \? FOR UPDATE/);
    // Rows before the job, then the job's re-check, then the writes.
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(executeRawMock.mock.invocationCallOrder[0]);
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(postJobCountMock.mock.invocationCallOrder[0]);
    expect(postJobCountMock.mock.invocationCallOrder[0]).toBeLessThan(resultUpdateManyMock.mock.invocationCallOrder[0]);
    expect(postJobCountMock).toHaveBeenCalledWith({ where: { id: "job-1", ...jobStillStale } });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending", claimRunId: null },
      data: { status: "failed", ...PUBLISH_STALLED_FAILURE },
    });
    expect(out).toEqual({ marked: true, failedCount: 2, unconfirmedCount: 2, status: "failed" });
  });

  it.each([
    ["claimed after the cutoff (a run woke)", { claimedAt: new Date("2026-11-02T09:00:00.000Z"), deferredUntil: null }],
    ["waiting out a platform limit that ended after the cutoff", { claimedAt: null, deferredUntil: new Date("2026-11-02T05:00:00.000Z") }],
  ])("a pending row %s: nothing is marked, the job is not even locked", async (_label, row) => {
    queryRawMock.mockResolvedValue([{ id: "r1", claimedAt: null, deferredUntil: null }, { id: "r2", ...row }]);
    const out = await run();

    expect(out).toEqual({ marked: false });
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(postJobUpdateMock).not.toHaveBeenCalled();
  });

  it("the job was touched since the candidate read (status or heartbeat): nothing is marked or recomputed", async () => {
    postJobCountMock.mockResolvedValue(0);
    const out = await run();

    expect(out).toEqual({ marked: false });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(postJobUpdateMock).not.toHaveBeenCalled();
  });

  it("the source names the order and why", () => {
    const source = readFileSync(new URL("./failPendingResults.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function failPendingResultsIfStillStale"));
    expect(body.indexOf('FROM "PostJobResult"')).toBeGreaterThan(-1);
    expect(body.indexOf('FROM "PostJobResult"')).toBeLessThan(body.indexOf('FROM "PostJob" WHERE'));
    expect(source).toMatch(/Lock order: the job's pending result rows, then the job/);
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

  // Final review F7 (M3): Prisma's defaults (maxWait 2 s, timeout 5 s) are too tight
  // for a transaction that may queue behind another finalizer's row lock on a
  // small pool, and implicit. The options are explicit.
  it("opens the transaction with maxWait 5 s and a 10 s timeout", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }]);

    await recomputeAndStorePostJobStatus("job-1");

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 10_000 });
    expect(RECOMPUTE_TX_MAX_WAIT_MS).toBe(5_000);
    expect(RECOMPUTE_TX_TIMEOUT_MS).toBe(10_000);
  });

  it("opens the transaction with the same options when failPendingPostJobResults recomputes", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(transactionMock.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 10_000 });
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
            findUnique: async () => ({ mediaItemId: "media-1", media: [] }),
          },
          mediaItem: { updateMany: async () => ({ count: 1 }) },
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

// F1 H2: retention counts a media item's age from its LAST use. The create path
// stamps lastUsedAt when a post is made, so a post scheduled (or a draft kept)
// for weeks, or a repeat series, finished with media the sweep already saw as
// old. Finalizing a job stamps it again, on every item the post used.
describe("recomputeAndStorePostJobStatus - media last use (F1 H2)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function stampedAt(): Date {
    const { data } = mediaUpdateManyMock.mock.calls.at(-1)![0] as { data: { lastUsedAt: Date } };
    return data.lastUsedAt;
  }

  it.each([
    ["completed", [{ status: "success" }, { status: "failed" }]],
    ["failed", [{ status: "failed" }]],
  ] as const)("stamps lastUsedAt on the post's media when the job ends %s", async (_status, results) => {
    resultFindManyMock.mockResolvedValue([...results]);
    const before = Date.now();

    await recomputeAndStorePostJobStatus("job-1");

    expect(postJobFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      select: { mediaItemId: true, media: { select: { mediaItemId: true } } },
    });
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["media-1"] }, deletedAt: null },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(stampedAt().getTime()).toBeGreaterThanOrEqual(before);
    // Inside the transaction, after the status write.
    expect(postJobUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      mediaUpdateManyMock.mock.invocationCallOrder[0],
    );
  });

  it("stamps every photo of a post with several", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }]);
    postJobFindUniqueMock.mockResolvedValue({
      mediaItemId: "photo-1",
      media: [{ mediaItemId: "photo-1" }, { mediaItemId: "photo-2" }, { mediaItemId: "photo-3" }],
    });

    await recomputeAndStorePostJobStatus("job-1");

    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["photo-1", "photo-2", "photo-3"] }, deletedAt: null },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("stamps nothing while the job is still running", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }, { status: "pending" }]);

    await recomputeAndStorePostJobStatus("job-1");

    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("stamps nothing for a post without a file", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }]);
    postJobFindUniqueMock.mockResolvedValue({ mediaItemId: null, media: [] });

    await recomputeAndStorePostJobStatus("job-1");

    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("keeps media attached 40 days ago, whose post completes today, for another 30 days", async () => {
    resultFindManyMock.mockResolvedValue([{ status: "success" }]);
    await recomputeAndStorePostJobStatus("job-1");
    const today = stampedAt();
    const createdAt = new Date(today.getTime() - 40 * DAY);
    const at = (days: number) =>
      isMediaSweepEligible({
        deletedAt: null,
        hasNonTerminalJob: false,
        hasAnyJob: true,
        lastUsedAt: today,
        createdAt,
        now: new Date(today.getTime() + days * DAY),
        retentionDays: RETENTION_DAYS,
      });

    expect(at(0)).toBe(false);
    expect(at(29)).toBe(false);
    expect(at(31)).toBe(true);
  });

  it("keeps the media of a series of 6 weekly posts until 30 days after the last one", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-01-05T09:00:00.000Z");
      resultFindManyMock.mockResolvedValue([{ status: "success" }]);
      for (let week = 0; week < 6; week += 1) {
        vi.setSystemTime(new Date(start.getTime() + week * 7 * DAY));
        await recomputeAndStorePostJobStatus(`job-${week}`);
      }
      const last = stampedAt();
      expect(last).toEqual(new Date(start.getTime() + 5 * 7 * DAY));
      const at = (days: number) =>
        isMediaSweepEligible({
          deletedAt: null,
          hasNonTerminalJob: false,
          hasAnyJob: true,
          lastUsedAt: last,
          createdAt: start,
          now: new Date(last.getTime() + days * DAY),
          retentionDays: RETENTION_DAYS,
        });
      expect(at(29)).toBe(false);
      expect(at(31)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the rule for a never-posted upload as it was: never swept", () => {
    expect(
      isMediaSweepEligible({
        deletedAt: null,
        hasNonTerminalJob: false,
        hasAnyJob: false,
        lastUsedAt: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        now: new Date("2026-11-14T00:00:00.000Z"),
        retentionDays: RETENTION_DAYS,
      }),
    ).toBe(false);
  });
});

// Review round 2, item 6: every path that ends a job outside the locked
// recompute (cancel, the bare no-connection fail, the reconcilers, the stale
// sweep) writes its final status through finishPostJob, so none can forget the
// media stamp.
describe("finishPostJob (review item 6)", () => {
  const NOW = new Date("2026-11-14T12:00:00.000Z");

  beforeEach(() => {
    finishDb.postJob.updateMany.mockReset();
    finishDb.postJob.findUnique.mockReset();
    finishDb.mediaItem.updateMany.mockReset();
    finishDb.postJob.findUnique.mockResolvedValue({ mediaItemId: "media-1", media: [] });
    finishDb.mediaItem.updateMany.mockResolvedValue({ count: 1 });
  });

  it("writes the final status with the caller's conditions, then stamps the post's media", async () => {
    finishDb.postJob.updateMany.mockResolvedValue({ count: 1 });

    const count = await finishPostJob(finishDb as unknown as Parameters<typeof finishPostJob>[0], {
      where: { id: "job-1", status: "in_progress" },
      data: { status: "failed" },
      now: NOW,
    });

    expect(count).toBe(1);
    expect(finishDb.postJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "in_progress" },
      data: { status: "failed" },
    });
    expect(finishDb.mediaItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["media-1"] }, deletedAt: null },
      data: { lastUsedAt: NOW },
    });
  });

  it("stamps nothing when the write matched no row (another writer moved the job first)", async () => {
    finishDb.postJob.updateMany.mockResolvedValue({ count: 0 });

    const count = await finishPostJob(finishDb as unknown as Parameters<typeof finishPostJob>[0], { where: { id: "job-1" }, data: { status: "cancelled" }, now: NOW });

    expect(count).toBe(0);
    expect(finishDb.postJob.findUnique).not.toHaveBeenCalled();
    expect(finishDb.mediaItem.updateMany).not.toHaveBeenCalled();
  });
});

describe("failPendingPostJobResults - status recompute", () => {
  // KK4: the rows and the job status are one transaction, so marking either
  // fully happens or not at all (a half-marked job can't publish, yet the
  // route would keep its count).
  it("writes the result rows, then takes the job's row lock and recomputes, all in one transaction", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.invocationCallOrder[0]).toBeLessThan(
      resultUpdateManyMock.mock.invocationCallOrder[0],
    );
    // Rows before the job lock: the same order a platform step's result write
    // takes (result row, then its job's heartbeat), so the two can't deadlock.
    expect(resultUpdateManyMock.mock.invocationCallOrder[1]).toBeLessThan(
      executeRawMock.mock.invocationCallOrder[0],
    );
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      postJobUpdateMock.mock.invocationCallOrder[0],
    );
  });

  it("the status update failing fails the whole transaction, so the row writes roll back with it", async () => {
    const committed: string[] = [];
    transactionMock.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
      // A stand-in for the database: writes count only if the callback returns.
      const pending: string[] = [];
      resultUpdateManyMock.mockImplementation(async () => {
        pending.push("rows");
        return { count: 1 };
      });
      const value = await callback(tx);
      committed.push(...pending);
      return value;
    });
    postJobUpdateMock.mockRejectedValue(new Error("database blip"));

    await expect(failPendingPostJobResults("job-1", DISPATCH_FAILURE)).rejects.toThrow("database blip");
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(2);
    expect(committed).toEqual([]);
  });
});
