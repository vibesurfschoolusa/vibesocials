import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. Only the three Prisma methods the
// helper touches are mocked; `recomputePostJobStatus` stays REAL so the job
// status asserted below is the one the publish pipeline itself would compute.
const { resultUpdateManyMock, resultFindManyMock, postJobUpdateMock } = vi.hoisted(() => ({
  resultUpdateManyMock: vi.fn(),
  resultFindManyMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: { updateMany: resultUpdateManyMock, findMany: resultFindManyMock },
    postJob: { update: postJobUpdateMock },
  },
}));

import { DISPATCH_FAILURE, PUBLISH_UNCONFIRMED, failPendingPostJobResults } from "./failPendingResults";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

beforeEach(() => {
  resultUpdateManyMock.mockReset();
  resultFindManyMock.mockReset();
  postJobUpdateMock.mockReset();

  resultUpdateManyMock.mockResolvedValue({ count: 2 });
  resultFindManyMock.mockResolvedValue([{ status: "failed" }, { status: "failed" }]);
  postJobUpdateMock.mockResolvedValue({});
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
