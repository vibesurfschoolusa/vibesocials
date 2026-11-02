import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 scale audit (jobs, media retention): the sweep is now hourly and
// batched. `sweepExpiredMediaBatch` is one keyset-paged batch of at most 200
// candidates; the per-item transaction (FOR UPDATE, eligibility re-check,
// deletedAt write, deleteBlobUnlessShared) is the one the daily sweep always
// ran, so its blob-deletion cases moved here from mediaRetentionSweep.test.ts.
// vi.mock is hoisted above the imports: no database and no Vercel Blob is reached.
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  postJobCount: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));
const { delMock } = vi.hoisted(() => ({ delMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: { findMany: db.findMany },
    $transaction: db.transaction,
  },
}));
vi.mock("@vercel/blob", () => ({ del: delMock }));

import {
  RETENTION_BATCH_BUDGET_MS,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES_PER_RUN,
  sweepExpiredMediaBatch,
  type RetentionCursor,
} from "./mediaRetentionBatch";
import { RETENTION_DAYS } from "./mediaRetention";

const STALE = new Date("2025-01-01T00:00:00Z");
const NOW = new Date("2026-11-02T10:15:00.000Z");
const CUTOFF = new Date(NOW.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
const BLOB_URL = "https://example.public.blob.vercel-storage.com/a.mp4";

/** `count` candidate rows, ascending by (createdAt, id) like the query's orderBy. */
function rows(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `media-${String(from + i).padStart(4, "0")}`,
    createdAt: new Date(STALE.getTime() + (from + i) * 1000),
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Hermetic: the shared-blob guard rewrites Vercel Blob hosts to the own store.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  for (const mock of Object.values(db)) mock.mockReset();
  delMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  db.findMany.mockResolvedValue(rows(1));
  db.findUnique.mockResolvedValue({
    storageLocation: BLOB_URL,
    deletedAt: null,
    lastUsedAt: STALE,
    createdAt: STALE,
    _count: { postJobs: 1 },
  });
  db.postJobCount.mockResolvedValue(0);
  db.count.mockResolvedValue(0);
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: db.executeRaw,
      postJob: { count: db.postJobCount },
      mediaItem: { findUnique: db.findUnique, update: db.update, count: db.count },
    }),
  );
});

describe("batch constants", () => {
  it("pins the batch size, the batches per run and the in-step budget", () => {
    expect(RETENTION_BATCH_SIZE).toBe(200);
    expect(RETENTION_MAX_BATCHES_PER_RUN).toBe(15);
    expect(RETENTION_BATCH_BUDGET_MS).toBe(150_000);
  });

  it("drains at least twice the reference inflow (about 10,000 a day) in 24 hourly runs", () => {
    expect(RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES_PER_RUN * 24).toBeGreaterThanOrEqual(20_000);
  });
});

describe("sweepExpiredMediaBatch - the candidate query", () => {
  const STALENESS = {
    OR: [{ lastUsedAt: { lt: CUTOFF } }, { lastUsedAt: null, createdAt: { lt: CUTOFF } }],
  };

  it("keyset-pages on (createdAt, id) below the cutoff, with today's eligibility filters", async () => {
    await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany.mock.calls[0][0]).toEqual({
      where: {
        deletedAt: null,
        createdAt: { lt: CUTOFF },
        postJobs: {
          some: {},
          none: { status: { notIn: ["completed", "failed", "cancelled"] } },
        },
        AND: [STALENESS],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: { id: true, createdAt: true },
    });
  });

  it("resumes strictly after the cursor with an (createdAt, id) OR condition", async () => {
    const after: RetentionCursor = { createdAt: "2025-01-01T00:03:20.000Z", id: "media-0200" };

    await sweepExpiredMediaBatch({ after, now: NOW });

    const cursorAt = new Date("2025-01-01T00:03:20.000Z");
    expect(db.findMany.mock.calls[0][0]).toEqual({
      where: {
        deletedAt: null,
        createdAt: { lt: CUTOFF },
        postJobs: {
          some: {},
          none: { status: { notIn: ["completed", "failed", "cancelled"] } },
        },
        AND: [STALENESS],
        OR: [{ createdAt: { gt: cursorAt } }, { createdAt: cursorAt, id: { gt: "media-0200" } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: { id: true, createdAt: true },
    });
  });

  it("honours a custom take", async () => {
    await sweepExpiredMediaBatch({ after: null, now: NOW, take: 7 });

    expect(db.findMany.mock.calls[0][0]).toMatchObject({ take: 7 });
  });
});

describe("sweepExpiredMediaBatch - exhaustion and the cursor", () => {
  it("a short page (150 of 200) is the last: exhausted, with next set to its last row", async () => {
    const page = rows(150);
    db.findMany.mockResolvedValue(page);

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(result).toEqual({
      candidates: 150,
      swept: 150,
      skipped: 0,
      errors: 0,
      next: { createdAt: page[149].createdAt.toISOString(), id: "media-0149" },
      exhausted: true,
    });
  });

  it("a full page (200 of 200) is not the last: next is the last row and exhausted is false", async () => {
    const page = rows(200);
    db.findMany.mockResolvedValue(page);

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(result).toMatchObject({
      candidates: 200,
      swept: 200,
      exhausted: false,
      next: { createdAt: page[199].createdAt.toISOString(), id: "media-0199" },
    });
  });

  it("an empty page is exhausted and keeps the cursor it was given", async () => {
    db.findMany.mockResolvedValue([]);
    const after: RetentionCursor = { createdAt: "2025-01-01T00:00:00.000Z", id: "media-0001" };

    const first = await sweepExpiredMediaBatch({ after: null, now: NOW });
    const later = await sweepExpiredMediaBatch({ after, now: NOW });

    expect(first).toEqual({ candidates: 0, swept: 0, skipped: 0, errors: 0, next: null, exhausted: true });
    expect(later).toMatchObject({ candidates: 0, next: after, exhausted: true });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("returns a JSON-safe cursor (ISO string), so it survives step memoization", async () => {
    db.findMany.mockResolvedValue(rows(3));

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(typeof result.next?.createdAt).toBe("string");
  });

  it("an errored or skipped row still advances the cursor, so it is not selected again in this run", async () => {
    const page = rows(3);
    db.findMany.mockResolvedValue(page);
    db.transaction
      .mockImplementationOnce(async () => "skipped")
      .mockImplementationOnce(async () => {
        throw new Error("blob store down");
      });
    // The third call falls back to the default implementation (a real sweep).

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(result).toMatchObject({ candidates: 3, swept: 1, skipped: 1, errors: 1, exhausted: true });
    expect(result.next).toEqual({ createdAt: page[2].createdAt.toISOString(), id: "media-0002" });
  });
});

describe("sweepExpiredMediaBatch - the in-step time budget", () => {
  it("stops once the clock is past the budget: 2 items processed, next is the 2nd, not exhausted", async () => {
    const page = rows(5);
    db.findMany.mockResolvedValue(page);
    let nowMs = 1_000_000;
    // The 2nd item's soft-delete is the moment the budget runs out.
    db.update.mockImplementation(async () => {
      if (db.update.mock.calls.length === 2) nowMs += RETENTION_BATCH_BUDGET_MS + 1;
    });

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW, clock: () => nowMs });

    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      candidates: 5,
      swept: 2,
      skipped: 0,
      errors: 0,
      next: { createdAt: page[1].createdAt.toISOString(), id: "media-0001" },
      exhausted: false,
    });
  });

  it("uses budgetMs when given, and RETENTION_BATCH_BUDGET_MS by default", async () => {
    db.findMany.mockResolvedValue(rows(5));
    let nowMs = 0;
    db.update.mockImplementation(async () => {
      nowMs += 10;
    });

    const result = await sweepExpiredMediaBatch({
      after: null,
      now: NOW,
      budgetMs: 25,
      clock: () => nowMs,
    });
    // 10 ms per item: still inside 25 ms after item 2 (20), over it after item 3 (30).
    expect(result.swept).toBe(3);

    nowMs = 0;
    db.transaction.mockClear();
    const unbounded = await sweepExpiredMediaBatch({ after: null, now: NOW, clock: () => nowMs });
    expect(unbounded.swept).toBe(5);
  });

  it("always processes at least one item, however small the budget", async () => {
    db.findMany.mockResolvedValue(rows(4));

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW, budgetMs: 0, clock: () => 5 });

    expect(result.swept).toBe(1);
    expect(result.exhausted).toBe(false);
  });

  it("a budget that runs out on the LAST row of a short page is still exhausted", async () => {
    const page = rows(2);
    db.findMany.mockResolvedValue(page);
    let nowMs = 0;
    db.update.mockImplementation(async () => {
      if (db.update.mock.calls.length === 2) nowMs += RETENTION_BATCH_BUDGET_MS + 1;
    });

    const result = await sweepExpiredMediaBatch({ after: null, now: NOW, clock: () => nowMs });

    expect(result).toMatchObject({ candidates: 2, swept: 2, exhausted: true });
  });
});

describe("sweepExpiredMediaBatch - blob deletion (moved from mediaRetentionSweep.test.ts)", () => {
  it("soft-deletes the row and removes the blob when nothing else references the URL", async () => {
    const summary = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(summary).toMatchObject({ candidates: 1, swept: 1, skipped: 0, errors: 0 });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith({ where: { id: "media-0000" }, data: { deletedAt: NOW } });
    expect(delMock).toHaveBeenCalledWith(BLOB_URL, { abortSignal: expect.any(AbortSignal) });
  });

  it("locks the row FOR UPDATE inside a 15 s transaction before it re-checks eligibility", async () => {
    await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15000 });
    expect(db.executeRaw).toHaveBeenCalledTimes(2); // the row lock + the blob advisory lock
    expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.findUnique.mock.invocationCallOrder[0]);
  });

  it("kept_shared: soft-deletes the row but KEEPS the blob when another live MediaItem shares the URL", async () => {
    db.count.mockResolvedValue(1);

    const summary = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(summary).toMatchObject({ candidates: 1, swept: 1, skipped: 0, errors: 0 });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.count).toHaveBeenCalledWith({
      where: {
        storageLocation: { in: [BLOB_URL] },
        id: { not: "media-0000" },
        deletedAt: null,
      },
    });
    expect(delMock).not.toHaveBeenCalled();
  });

  it("touches neither the row nor the blob when the item is no longer eligible", async () => {
    db.postJobCount.mockResolvedValue(1); // a non-terminal job appeared

    const summary = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(summary).toMatchObject({ swept: 0, skipped: 1 });
    expect(db.update).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("skips a row that vanished between the candidate query and the lock", async () => {
    db.findUnique.mockResolvedValue(null);

    const summary = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(summary).toMatchObject({ swept: 0, skipped: 1, errors: 0 });
    expect(delMock).not.toHaveBeenCalled();
  });

  it("counts a failed blob delete as an error and keeps going (the transaction rolls the row back)", async () => {
    db.findMany.mockResolvedValue(rows(2));
    // A throw inside the callback rejects out of $transaction (the real client
    // rolls the soft-delete back), so the item is an error, not a sweep.
    delMock.mockRejectedValueOnce(new Error("blob store down")).mockResolvedValue(undefined);

    const summary = await sweepExpiredMediaBatch({ after: null, now: NOW });

    expect(summary).toMatchObject({ candidates: 2, swept: 1, errors: 1 });
  });
});
