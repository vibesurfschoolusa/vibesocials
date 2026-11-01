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

import { DISPATCH_FAILURE, failPendingPostJobResults } from "./failPendingResults";

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

describe("failPendingPostJobResults", () => {
  it("fails only the job's still-pending results, with the given code + message", async () => {
    await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", status: "pending" },
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
      where: { postJobId: "job-9", status: "pending" },
      data: {
        status: "failed",
        errorCode: "PUBLISH_INTERRUPTED",
        errorMessage: "Publishing was interrupted. Please retry.",
      },
    });
  });

  it("recomputes the job status over ALL its results after the update", async () => {
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
    expect(outcome).toEqual({ failedCount: 2, status: "failed" });
  });

  it("keeps a partial success completed (a platform that already went live stays live)", async () => {
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    resultFindManyMock.mockResolvedValue([{ status: "success" }, { status: "failed" }]);

    const outcome = await failPendingPostJobResults("job-1", DISPATCH_FAILURE);

    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "completed" },
    });
    expect(outcome).toEqual({ failedCount: 1, status: "completed" });
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
      where: { postJobId: "job-1", status: "pending", platform: { in: ["x", "tiktok"] } },
      data: {
        status: "failed",
        errorCode: "PUBLISH_INTERRUPTED",
        errorMessage: "Publishing was interrupted. Please retry.",
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

    expect(resultUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postJobId: "job-1", status: "pending" } }),
    );
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
});
