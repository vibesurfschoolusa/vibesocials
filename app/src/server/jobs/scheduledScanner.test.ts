import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. scheduledScanner.ts imports `@/lib/db` at
// module scope, so mock it before the import below (mirrors the route tests).
const { findManyMock, updateManyMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findMany: findManyMock, updateMany: updateManyMock },
  },
}));

import { claimDueScheduledJobs, DUE_SCAN_BATCH } from "./scheduledScanner";

const NOW = new Date("2026-07-10T12:00:00.000Z");

beforeEach(() => {
  findManyMock.mockReset();
  updateManyMock.mockReset();
});

describe("claimDueScheduledJobs", () => {
  it("queries only scheduled jobs that are due, oldest first, capped by batch", async () => {
    findManyMock.mockResolvedValue([]);

    await claimDueScheduledJobs(NOW);

    expect(findManyMock).toHaveBeenCalledWith({
      where: { status: "scheduled", scheduledFor: { lte: NOW } },
      select: { id: true },
      orderBy: { scheduledFor: "asc" },
      take: DUE_SCAN_BATCH,
    });
  });

  it("claims each due job via a conditional updateMany and returns the claimed ids", async () => {
    findManyMock.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const claimed = await claimDueScheduledJobs(NOW);

    expect(claimed).toEqual(["a", "b"]);
    // The claim is conditional on status STILL being "scheduled" — the atomic guard.
    expect(updateManyMock).toHaveBeenNthCalledWith(1, {
      where: { id: "a", status: "scheduled" },
      data: { status: "in_progress" },
    });
    expect(updateManyMock).toHaveBeenNthCalledWith(2, {
      where: { id: "b", status: "scheduled" },
      data: { status: "in_progress" },
    });
  });

  it("drops a job it couldn't claim (count 0 — another scanner/cancel won the race)", async () => {
    findManyMock.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    updateManyMock
      .mockResolvedValueOnce({ count: 1 }) // a claimed
      .mockResolvedValueOnce({ count: 0 }) // b already taken → dropped
      .mockResolvedValueOnce({ count: 1 }); // c claimed

    const claimed = await claimDueScheduledJobs(NOW);

    expect(claimed).toEqual(["a", "c"]);
  });

  it("returns an empty list when nothing is due (no update attempts)", async () => {
    findManyMock.mockResolvedValue([]);

    const claimed = await claimDueScheduledJobs(NOW);

    expect(claimed).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("honors an explicit take override", async () => {
    findManyMock.mockResolvedValue([]);
    await claimDueScheduledJobs(NOW, 5);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });
});
