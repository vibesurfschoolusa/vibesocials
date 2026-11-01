import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. scheduledScanner.ts imports `@/lib/db` at
// module scope, so mock it before the import below (mirrors the route tests).
const {
  queryRawMock,
  findManyMock,
  updateManyMock,
  resultFindManyMock,
  resultUpdateManyMock,
} = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  resultFindManyMock: vi.fn(),
  resultUpdateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: queryRawMock,
    postJob: { findMany: findManyMock, updateMany: updateManyMock },
    postJobResult: {
      findMany: resultFindManyMock,
      updateMany: resultUpdateManyMock,
    },
  },
}));

import {
  claimDueScheduledJobs,
  DUE_SCAN_BATCH,
  reconcileStuckInProgressJobs,
  STUCK_IN_PROGRESS_MS,
} from "./scheduledScanner";

const NOW = new Date("2026-07-10T12:00:00.000Z");

beforeEach(() => {
  queryRawMock.mockReset();
  findManyMock.mockReset();
  updateManyMock.mockReset();
  resultFindManyMock.mockReset();
  resultUpdateManyMock.mockReset();
});

describe("claimDueScheduledJobs", () => {
  /** The SQL text of the (single) claim statement, whitespace-collapsed. */
  function claimSql(): string {
    const [strings] = queryRawMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return strings.join("$").replace(/\s+/g, " ");
  }

  function claimValues(): unknown[] {
    return (queryRawMock.mock.calls[0] as unknown[]).slice(1);
  }

  // 2026-11-01 audit (Task 4 item 5): the claim used to find due rows and
  // flip them one by one inside one step — a mid-loop error + step retry
  // stranded the rows it had already flipped (in_progress, never dispatched,
  // never re-queried). It is now ONE statement that claims and returns the ids.
  it("claims every due job in ONE atomic statement and returns the claimed ids", async () => {
    queryRawMock.mockResolvedValue([{ id: "a" }, { id: "b" }]);

    const claimed = await claimDueScheduledJobs(NOW);

    expect(claimed).toEqual(["a", "b"]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("flips only still-scheduled, due rows to in_progress, oldest first, skipping rows another scanner holds", async () => {
    queryRawMock.mockResolvedValue([]);

    await claimDueScheduledJobs(NOW);

    const sql = claimSql();
    expect(sql).toMatch(/UPDATE "PostJob" SET "status" = 'in_progress'::"PostJobStatus"/);
    expect(sql).toContain(`"status" = 'scheduled'::"PostJobStatus"`);
    expect(sql).toMatch(/"scheduledFor" <= \(\$::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(sql).toMatch(/ORDER BY "scheduledFor" ASC LIMIT \$ FOR UPDATE SKIP LOCKED/);
    expect(sql).toContain('RETURNING "id"');
    expect(claimValues()).toContain(NOW);
    expect(claimValues()).toContain(DUE_SCAN_BATCH);
  });

  // Task 4 item 8a (controller ruling R6): a row left `scheduled` by the old
  // approval bypass — submitted but never approved — must never be claimed.
  it("never claims a submitted-but-unapproved job", async () => {
    queryRawMock.mockResolvedValue([]);

    await claimDueScheduledJobs(NOW);

    expect(claimSql()).toContain(
      'AND NOT ("submittedForApprovalAt" IS NOT NULL AND "approvedAt" IS NULL)',
    );
  });

  it("returns an empty list when nothing is due", async () => {
    queryRawMock.mockResolvedValue([]);

    expect(await claimDueScheduledJobs(NOW)).toEqual([]);
  });

  it("honors an explicit take override", async () => {
    queryRawMock.mockResolvedValue([]);
    await claimDueScheduledJobs(NOW, 5);
    expect(claimValues()).toContain(5);
    expect(claimValues()).not.toContain(DUE_SCAN_BATCH);
  });
});

describe("reconcileStuckInProgressJobs", () => {
  it("marks a stuck job with no results as failed", async () => {
    findManyMock.mockResolvedValue([{ id: "stuck-1" }]);
    resultFindManyMock.mockResolvedValue([]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const out = await reconcileStuckInProgressJobs(NOW);

    expect(out.reconciled).toBe(1);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "in_progress",
          updatedAt: { lt: new Date(NOW.getTime() - STUCK_IN_PROGRESS_MS) },
        },
      }),
    );
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "stuck-1", status: "in_progress" },
      data: { status: "failed" },
    });
  });

  it("fails pending results then recomputes terminal status", async () => {
    findManyMock.mockResolvedValue([{ id: "stuck-2" }]);
    resultFindManyMock
      .mockResolvedValueOnce([
        { id: "r1", status: "pending" },
        { id: "r2", status: "success" },
      ])
      .mockResolvedValueOnce([
        { status: "failed" },
        { status: "success" },
      ]);
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    updateManyMock.mockResolvedValue({ count: 1 });

    const out = await reconcileStuckInProgressJobs(NOW);

    expect(out.reconciled).toBe(1);
    expect(resultUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["r1"] }, status: "pending" },
      }),
    );
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "stuck-2", status: "in_progress" },
      data: { status: "completed" },
    });
  });
});
