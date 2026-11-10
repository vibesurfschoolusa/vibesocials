import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-level test for the hourly media retention sweep (2026-11-01 scale
// audit, jobs). The handler only loops `sweep-batch-<i>` steps over
// `sweepExpiredMediaBatch`; the batch itself (query, per-item transaction, blob
// deletion) is covered by mediaRetentionBatch.test.ts, where the shared-blob
// cases moved. vi.mock is hoisted above the imports: no database, Vercel Blob
// or Inngest is reached.
const { batchMock, drainMock } = vi.hoisted(() => ({ batchMock: vi.fn(), drainMock: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/server/platforms", () => ({ getPlatformClient: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/failPendingResults", () => ({ failPendingPostJobResults: vi.fn() }));
vi.mock("@/server/jobs/mediaRetentionBatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/mediaRetentionBatch")>()),
  sweepExpiredMediaBatch: batchMock,
}));

vi.mock("@/server/jobs/pendingBlobDeletion", () => ({ drainPendingBlobDeletions: drainMock }));

import { inngestFunctions, mediaRetentionSweep } from "./inngest-functions";
import {
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES_PER_RUN,
  type RetentionCursor,
} from "./mediaRetentionBatch";

type BatchResult = {
  candidates: number;
  swept: number;
  skipped: number;
  errors: number;
  next: RetentionCursor | null;
  exhausted: boolean;
};
type RunSummary = {
  batches: number;
  candidates: number;
  swept: number;
  skipped: number;
  errors: number;
  exhausted: boolean;
};

/** Stand-in for Inngest's `step`: runs inline, JSON-round-trips outputs like memoization, records ids. */
function fakeStep() {
  const ids: string[] = [];
  return {
    ids,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      ids.push(id);
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
  };
}
type FakeStep = ReturnType<typeof fakeStep>;

function runSweep(step: FakeStep): Promise<RunSummary> {
  const handler = (mediaRetentionSweep as unknown as {
    fn: (args: { step: FakeStep }) => Promise<RunSummary>;
  }).fn;
  return handler({ step });
}

const cursor = (i: number): RetentionCursor => ({
  createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
  id: `media-${i}`,
});
const fullBatch = (i: number): BatchResult => ({
  candidates: RETENTION_BATCH_SIZE,
  swept: RETENTION_BATCH_SIZE - 2,
  skipped: 1,
  errors: 1,
  next: cursor(i),
  exhausted: false,
});

const DRAIN = "drain-pending-blob-deletions";

beforeEach(() => {
  batchMock.mockReset();
  drainMock.mockReset();
  drainMock.mockResolvedValue({ deleted: 0, kept: 0, left: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("mediaRetentionSweep - registration", () => {
  const optsOf = () => (mediaRetentionSweep as unknown as { opts: Record<string, unknown> }).opts;
  // What Inngest's serve() registers for the function (private in the SDK's
  // types, public at runtime).
  const registered = () => {
    const { getConfig } = mediaRetentionSweep as unknown as {
      getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
    };
    return getConfig
      .call(mediaRetentionSweep, {
        baseUrl: new URL("https://app.example/api/inngest"),
        appPrefix: "vibe-socials",
      })
      .find((config) => config.id === "vibe-socials-media-retention-sweep");
  };

  it("keeps its function id (a contract with in-flight runs)", () => {
    expect(optsOf().id).toBe("media-retention-sweep");
    expect(registered()).toBeDefined();
  });

  it("runs hourly at :15", () => {
    expect(registered()?.triggers).toEqual([{ cron: "15 * * * *" }]);
  });

  it("is a singleton: a tick that arrives while a sweep is still draining is skipped", () => {
    expect(optsOf().singleton).toEqual({ mode: "skip" });
  });

  it("is registered with the Inngest handler", () => {
    expect(inngestFunctions).toContain(mediaRetentionSweep);
  });
});

describe("mediaRetentionSweep - the batch loop", () => {
  it("stops at the first exhausted batch: batch 0 not exhausted, batch 1 exhausted -> exactly 2 steps", async () => {
    batchMock
      .mockResolvedValueOnce(fullBatch(1))
      .mockResolvedValueOnce({
        candidates: 40,
        swept: 40,
        skipped: 0,
        errors: 0,
        next: cursor(2),
        exhausted: true,
      } satisfies BatchResult);
    const step = fakeStep();

    const summary = await runSweep(step);

    expect(step.ids).toEqual(["sweep-batch-0", "sweep-batch-1", DRAIN]);
    expect(batchMock).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      batches: 2,
      candidates: RETENTION_BATCH_SIZE + 40,
      swept: RETENTION_BATCH_SIZE - 2 + 40,
      skipped: 1,
      errors: 1,
      exhausted: true,
    });
  });

  it("runs a single step when there is nothing to sweep", async () => {
    batchMock.mockResolvedValueOnce({
      candidates: 0,
      swept: 0,
      skipped: 0,
      errors: 0,
      next: null,
      exhausted: true,
    } satisfies BatchResult);
    const step = fakeStep();

    const summary = await runSweep(step);

    expect(step.ids).toEqual(["sweep-batch-0", DRAIN]);
    expect(summary).toMatchObject({ batches: 1, candidates: 0, exhausted: true });
  });

  it("threads each batch's cursor into the next: the first starts at null", async () => {
    batchMock
      .mockResolvedValueOnce(fullBatch(1))
      .mockResolvedValueOnce(fullBatch(2))
      .mockResolvedValueOnce({ ...fullBatch(3), exhausted: true });

    await runSweep(fakeStep());

    expect(batchMock.mock.calls.map(([opts]) => opts)).toEqual([
      { after: null },
      { after: cursor(1) },
      { after: cursor(2) },
    ]);
  });

  it("caps a run at 15 batch steps when the backlog never exhausts", async () => {
    let i = 0;
    batchMock.mockImplementation(async () => fullBatch(++i));
    const step = fakeStep();

    const summary = await runSweep(step);

    expect(RETENTION_MAX_BATCHES_PER_RUN).toBe(15);
    expect(step.ids).toEqual([...Array.from({ length: 15 }, (_, n) => `sweep-batch-${n}`), DRAIN]);
    expect(batchMock).toHaveBeenCalledTimes(15);
    expect(summary).toMatchObject({
      batches: 15,
      candidates: 15 * RETENTION_BATCH_SIZE,
      exhausted: false,
    });
  });

  it("does not restart from the beginning when a batch reports no cursor but is not exhausted", async () => {
    batchMock.mockResolvedValue({
      candidates: 0,
      swept: 0,
      skipped: 0,
      errors: 0,
      next: null,
      exhausted: false,
    } satisfies BatchResult);
    const step = fakeStep();

    const summary = await runSweep(step);

    expect(step.ids).toEqual(["sweep-batch-0", DRAIN]);
    expect(summary.exhausted).toBe(false);
  });

  it("leaves row-level failures to the batch: an errored item is counted, not thrown", async () => {
    batchMock.mockResolvedValueOnce({
      candidates: 5,
      swept: 3,
      skipped: 1,
      errors: 1,
      next: cursor(5),
      exhausted: true,
    } satisfies BatchResult);

    await expect(runSweep(fakeStep())).resolves.toMatchObject({ swept: 3, skipped: 1, errors: 1 });
  });

  it("propagates a thrown batch (a failed candidate query) so Inngest retries that step", async () => {
    batchMock.mockRejectedValueOnce(new Error("db down"));

    await expect(runSweep(fakeStep())).rejects.toThrow("db down");
  });
});

describe("mediaRetentionSweep - the pending blob deletion queue", () => {
  it("drains the queue in one last step, after the sweep batches", async () => {
    batchMock.mockResolvedValueOnce({
      candidates: 0,
      swept: 0,
      skipped: 0,
      errors: 0,
      next: null,
      exhausted: true,
    } satisfies BatchResult);
    const step = fakeStep();

    await runSweep(step);

    expect(step.ids[step.ids.length - 1]).toBe(DRAIN);
    expect(step.ids.filter((id) => id === DRAIN)).toHaveLength(1);
    expect(drainMock).toHaveBeenCalledTimes(1);
  });
});
