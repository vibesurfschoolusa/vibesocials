import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-level test for the every-minute scheduled-post scanner. Mocks follow
// mediaRetentionSweep.test.ts: vi.mock is hoisted above the imports, no database,
// platform API or Inngest is reached. The scanner's claim/reconcile queries and
// the deferred-dispatch DB work are stubbed; `materializeClaimedJobs` and the event
// builder stay REAL, so the chunking, step ids and event shapes are asserted for real.
const { claimDueMock, reconcileMock, prepareDeferredMock, ownerFindUniqueMock } = vi.hoisted(
  () => ({
    claimDueMock: vi.fn(),
    reconcileMock: vi.fn(),
    prepareDeferredMock: vi.fn(),
    ownerFindUniqueMock: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: { postJob: { findUnique: ownerFindUniqueMock } },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/failPendingResults", () => ({
  failPendingPostJobResults: vi.fn(),
  recomputeAndStorePostJobStatus: vi.fn(),
}));
vi.mock("@/server/jobs/scheduledScanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/scheduledScanner")>()),
  claimDueScheduledJobs: claimDueMock,
  reconcileStuckInProgressJobs: reconcileMock,
}));
vi.mock("@/server/jobs/posting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/posting")>()),
  prepareDeferredPostJobDispatch: prepareDeferredMock,
}));

import { scheduledPostScanner } from "./inngest-functions";
import { DUE_SCAN_BATCH, MATERIALIZE_CHUNK_SIZE } from "./scheduledScanner";

type ScanSummary = {
  claimed: number;
  dispatched: number;
  failedNoConnections: number;
  dispatchErrors: number;
};

type SentPayload = Array<{ id: string; name: string; data: Record<string, unknown> }>;

/**
 * Stand-in for Inngest's `step`: runs each step inline and JSON-round-trips its
 * output the way Inngest's memoization does, so a step that leaks a
 * non-serializable value shows up here.
 */
function fakeStep(sendEvent?: (id: string, payload: SentPayload) => Promise<unknown>) {
  return {
    run: vi.fn(async (_id: string, cb: () => unknown) => {
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
    sendEvent: vi.fn(sendEvent ?? (async () => ({ ids: [] as string[] }))),
  };
}

function runScanner(step: ReturnType<typeof fakeStep>): Promise<ScanSummary> {
  const handler = (scheduledPostScanner as unknown as {
    fn: (args: { event: unknown; step: typeof step; runId: string }) => Promise<ScanSummary>;
  }).fn;
  return handler({ event: { name: "inngest/scheduled.timer", data: {} }, step, runId: "run-1" });
}

/** `count` claimed ids: job-0 ... job-<count-1>. */
function claimed(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `job-${i}`);
}

function okFor(id: string) {
  return {
    ok: true as const,
    event: {
      postJobId: id,
      userId: "user-1",
      workspaceId: "ws-1",
      mediaItemId: `media-${id}`,
      baseCaption: "scheduled",
      perPlatformOverrides: null,
    },
  };
}

const stepIds = (step: ReturnType<typeof fakeStep>) => step.run.mock.calls.map(([id]) => id);
const sendIds = (step: ReturnType<typeof fakeStep>) => step.sendEvent.mock.calls.map(([id]) => id);
const sentPayload = (step: ReturnType<typeof fakeStep>, call: number) =>
  step.sendEvent.mock.calls[call]?.[1] as unknown as SentPayload;

beforeEach(() => {
  claimDueMock.mockReset();
  reconcileMock.mockReset();
  prepareDeferredMock.mockReset();
  ownerFindUniqueMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  reconcileMock.mockResolvedValue({ reconciled: 0 });
  prepareDeferredMock.mockImplementation(async (id: string) => okFor(id));
});

describe("scheduledPostScanner - options", () => {
  const optsOf = () => (scheduledPostScanner as unknown as { opts: Record<string, unknown> }).opts;

  // V6 (https://www.inngest.com/docs/guides/singleton): a new run is skipped while
  // one is active. A skipped tick is harmless: the next one claims whatever is due.
  it("skips a tick while the previous scan is still running", () => {
    expect(optsOf().singleton).toEqual({ mode: "skip" });
  });

  it("keeps its function id, a contract with in-flight runs", () => {
    expect(optsOf().id).toBe("scheduled-post-scanner");
  });

  it("claims up to 1000 due posts per tick and materializes 50 per step", () => {
    expect(DUE_SCAN_BATCH).toBe(1000);
    expect(MATERIALIZE_CHUNK_SIZE).toBe(50);
  });
});

describe("scheduledPostScanner - batched dispatch", () => {
  it("120 claimed jobs run as 3 chunked materialize steps and 3 batched sends (50, 50, 20)", async () => {
    claimDueMock.mockResolvedValue(claimed(120));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(stepIds(step)).toEqual([
      "claim-due-jobs",
      "reconcile-stuck-in-progress",
      "materialize-batch-0",
      "materialize-batch-1",
      "materialize-batch-2",
    ]);
    expect(step.sendEvent).toHaveBeenCalledTimes(3);
    expect(sendIds(step)).toEqual(["dispatch-batch-0", "dispatch-batch-1", "dispatch-batch-2"]);
    expect([0, 1, 2].map((i) => sentPayload(step, i).length)).toEqual([50, 50, 20]);
    // No per-job step ids: those were 2 steps per job (2,002 for a full tick).
    const everyId = [...stepIds(step), ...sendIds(step)];
    expect(everyId.filter((id) => /^(materialize|publish)-(?!batch)/.test(id))).toEqual([]);
    expect(summary).toEqual({
      claimed: 120,
      dispatched: 120,
      failedNoConnections: 0,
      dispatchErrors: 0,
    });
  });

  it("every event is a scheduled (immediate: false) publish with a stable id and the job's workspace", async () => {
    claimDueMock.mockResolvedValue(claimed(3));
    const step = fakeStep();

    await runScanner(step);

    expect(sentPayload(step, 0)).toEqual(
      claimed(3).map((id) => ({
        id: `publish-${id}`,
        name: "post/publish.requested",
        data: { ...okFor(id).event, immediate: false },
      })),
    );
  });

  // Today's per-job steps make a full tick 2 + 2 x 1000 = 2,002 steps, over Inngest's
  // 1,000-step run limit (V7). Batched, a tick is at most 2 + 3 x 20 = 62.
  it("a full 1000-post tick is 20 chunks of 50 and stays far under the 1,000-step run limit", async () => {
    claimDueMock.mockResolvedValue(claimed(DUE_SCAN_BATCH));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(summary.dispatched).toBe(1000);
    // claim + reconcile + 20 x (materialize + dispatch); a send is a step too.
    expect(step.run.mock.calls.length + step.sendEvent.mock.calls.length).toBe(2 + 2 * 20);
    expect(sentPayload(step, 19).length).toBe(50);
  });

  it("sends nothing when no job is due", async () => {
    claimDueMock.mockResolvedValue([]);
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(stepIds(step)).toEqual(["claim-due-jobs", "reconcile-stuck-in-progress"]);
    expect(summary).toEqual({
      claimed: 0,
      dispatched: 0,
      failedNoConnections: 0,
      dispatchErrors: 0,
    });
  });

  // Review Focus 3: a failed batch send must not strand the other chunks. The jobs
  // of the failed chunk stay in_progress; the stuck-job reconciler finalizes them.
  it("a rejected send fails only its own chunk: the other chunks are still sent", async () => {
    claimDueMock.mockResolvedValue(claimed(120));
    const step = fakeStep(async (id) => {
      if (id === "dispatch-batch-1") throw new Error("inngest unavailable");
      return { ids: [] };
    });

    const summary = await runScanner(step);

    expect(sendIds(step)).toEqual(["dispatch-batch-0", "dispatch-batch-1", "dispatch-batch-2"]);
    expect(summary).toEqual({
      claimed: 120,
      dispatched: 70,
      failedNoConnections: 0,
      dispatchErrors: 50,
    });
  });

  it("a job that throws while materializing is counted and does not hold back the rest of its chunk", async () => {
    claimDueMock.mockResolvedValue(claimed(4));
    prepareDeferredMock.mockImplementation(async (id: string) => {
      if (id === "job-1") throw new Error("pool timeout");
      return okFor(id);
    });
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(sentPayload(step, 0).map((e) => e.id)).toEqual([
      "publish-job-0",
      "publish-job-2",
      "publish-job-3",
    ]);
    expect(summary).toEqual({
      claimed: 4,
      dispatched: 3,
      failedNoConnections: 0,
      dispatchErrors: 1,
    });
  });

  it("a materialize step that fails outright counts its whole chunk and the next chunk still runs", async () => {
    claimDueMock.mockResolvedValue(claimed(60));
    const step = fakeStep();
    step.run.mockImplementation(async (id: string, cb: () => unknown) => {
      if (id === "materialize-batch-0") throw new Error("step exhausted its retries");
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    });

    const summary = await runScanner(step);

    expect(sendIds(step)).toEqual(["dispatch-batch-1"]);
    expect(summary).toEqual({
      claimed: 60,
      dispatched: 10,
      failedNoConnections: 0,
      dispatchErrors: 50,
    });
  });
});

describe("scheduledPostScanner - jobs with no connections", () => {
  it("notifies the owners of NO_CONNECTIONS jobs in one batched send, with a stable id per notification", async () => {
    claimDueMock.mockResolvedValue(["job-a", "job-n1", "job-n2"]);
    prepareDeferredMock.mockImplementation(async (id: string) =>
      id.startsWith("job-n") ? { ok: false, reason: "NO_CONNECTIONS" } : okFor(id),
    );
    ownerFindUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      userId: `owner-of-${where.id}`,
    }));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(stepIds(step)).toEqual([
      "claim-due-jobs",
      "reconcile-stuck-in-progress",
      "materialize-batch-0",
    ]);
    expect(sendIds(step)).toEqual(["dispatch-batch-0", "notify-noconn-batch-0"]);
    expect(sentPayload(step, 0).map((e) => e.id)).toEqual(["publish-job-a"]);
    expect(sentPayload(step, 1)).toEqual([
      {
        id: "notify-noconn-job-n1",
        name: "notification.requested",
        data: { userId: "owner-of-job-n1", postJobId: "job-n1" },
      },
      {
        id: "notify-noconn-job-n2",
        name: "notification.requested",
        data: { userId: "owner-of-job-n2", postJobId: "job-n2" },
      },
    ]);
    expect(summary).toEqual({
      claimed: 3,
      dispatched: 1,
      failedNoConnections: 2,
      dispatchErrors: 0,
    });
  });

  it("sends only the notification batch when every job in the chunk lacks connections", async () => {
    claimDueMock.mockResolvedValue(["job-n1"]);
    prepareDeferredMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });
    ownerFindUniqueMock.mockResolvedValue({ userId: "owner-1" });
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(sendIds(step)).toEqual(["notify-noconn-batch-0"]);
    expect(summary).toMatchObject({ dispatched: 0, failedNoConnections: 1, dispatchErrors: 0 });
  });

  it("a failed notification send is counted and does not undo the dispatch", async () => {
    claimDueMock.mockResolvedValue(["job-a", "job-n1"]);
    prepareDeferredMock.mockImplementation(async (id: string) =>
      id === "job-n1" ? { ok: false, reason: "NO_CONNECTIONS" } : okFor(id),
    );
    ownerFindUniqueMock.mockResolvedValue({ userId: "owner-1" });
    const step = fakeStep(async (id) => {
      if (id === "notify-noconn-batch-0") throw new Error("inngest unavailable");
      return { ids: [] };
    });

    const summary = await runScanner(step);

    expect(summary).toEqual({
      claimed: 2,
      dispatched: 1,
      failedNoConnections: 1,
      dispatchErrors: 1,
    });
  });
});
