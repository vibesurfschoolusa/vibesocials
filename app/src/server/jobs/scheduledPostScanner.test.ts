import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inngest } from "@/lib/inngest";

// Handler-level test for the every-5-minutes scheduled-post scanner. Mocks follow
// mediaRetentionSweep.test.ts: vi.mock is hoisted above the imports, no database,
// platform API or Inngest is reached. The scanner's claim/reconcile queries and
// the deferred-dispatch DB work are stubbed; `materializeAndDispatchChunk` and the
// event builder stay REAL, so the chunking, step ids, byte-bounded sends and event
// shapes are asserted for real. Events are sent with `inngest.send` (spied below);
// only the no-connections notifications go through `step.sendEvent`.
const { claimDueMock, reconcileMock, prepareDeferredMock, ownerFindUniqueMock, sendMock } =
  vi.hoisted(() => ({
    claimDueMock: vi.fn(),
    reconcileMock: vi.fn(),
    prepareDeferredMock: vi.fn(),
    ownerFindUniqueMock: vi.fn(),
    sendMock: vi.fn(),
  }));

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
import { DUE_SCAN_BATCH, MATERIALIZE_CHUNK_SIZE, MAX_DISPATCH_BYTES } from "./scheduledScanner";

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
 * non-serializable value shows up here. `sendEvent` is used only for the
 * no-connections notifications.
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

function okFor(id: string, baseCaption = "scheduled") {
  return {
    ok: true as const,
    event: {
      postJobId: id,
      userId: "user-1",
      workspaceId: "ws-1",
      mediaItemId: `media-${id}`,
      baseCaption,
      perPlatformOverrides: null,
    },
  };
}

const stepIds = (step: ReturnType<typeof fakeStep>) => step.run.mock.calls.map(([id]) => id);
const notifyIds = (step: ReturnType<typeof fakeStep>) => step.sendEvent.mock.calls.map(([id]) => id);
const notifyPayload = (step: ReturnType<typeof fakeStep>, call: number) =>
  step.sendEvent.mock.calls[call]?.[1] as unknown as SentPayload;
/** The events of each `inngest.send` call, in call order. */
const dispatches = () => sendMock.mock.calls.map(([events]) => events as SentPayload);

beforeEach(() => {
  claimDueMock.mockReset();
  reconcileMock.mockReset();
  prepareDeferredMock.mockReset();
  ownerFindUniqueMock.mockReset();
  sendMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(inngest, "send").mockImplementation(sendMock as unknown as typeof inngest.send);

  reconcileMock.mockResolvedValue({ reconciled: 0 });
  prepareDeferredMock.mockImplementation(async (id: string) => okFor(id));
  sendMock.mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.useRealTimers();
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

  // Inngest counts one execution per run plus one per step, and the free plan
  // stops ALL runs for the rest of the month at 50,000. Every minute with two
  // steps cost 3 x 1,440 = 4,320 a day, about 134,000 a month with nobody
  // posting (27,502 used by 2026-11-07). Every 5 minutes with one step is
  // 2 x 288 = 576 a day, about 17,900 in a 31-day month.
  it("runs every 5 minutes, so an idle month stays far under the free plan's 50,000 executions", () => {
    expect(optsOf().triggers).toEqual([{ cron: "*/5 * * * *" }]);
  });

  it("claims up to 1000 due posts per tick and materializes 50 per step", () => {
    expect(DUE_SCAN_BATCH).toBe(1000);
    expect(MATERIALIZE_CHUNK_SIZE).toBe(50);
  });
});

describe("scheduledPostScanner - batched dispatch", () => {
  it("120 claimed jobs run as 3 materialize-and-dispatch steps, with sends of 50, 50 and 20 events", async () => {
    claimDueMock.mockResolvedValue(claimed(120));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(stepIds(step)).toEqual([
      "claim-due-jobs",
      "materialize-dispatch-batch-0",
      "materialize-dispatch-batch-1",
      "materialize-dispatch-batch-2",
    ]);
    expect(dispatches().map((events) => events.length)).toEqual([50, 50, 20]);
    // Nothing needs notifying, so no step.sendEvent at all.
    expect(step.sendEvent).not.toHaveBeenCalled();
    // No per-job step ids: those were 2 steps per job (2,002 for a full tick).
    expect(stepIds(step).filter((id) => /^(materialize|publish)-(?!dispatch-batch-)/.test(id))).toEqual(
      [],
    );
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

    expect(dispatches()).toEqual([
      claimed(3).map((id) => ({
        id: `publish-${id}`,
        name: "post/publish.requested",
        data: { ...okFor(id).event, immediate: false },
      })),
    ]);
  });

  // The old per-job steps made a full tick 2 + 2 x 1000 = 2,002 steps, over Inngest's
  // 1,000-step run limit (V7). One step per chunk makes it 1 + 20, plus at most 20
  // notification sends.
  it("a full 1000-post tick is 20 chunk steps and stays far under the 1,000-step run limit", async () => {
    claimDueMock.mockResolvedValue(claimed(DUE_SCAN_BATCH));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(summary.dispatched).toBe(1000);
    expect(stepIds(step).length).toBe(1 + 20);
    expect(dispatches().length).toBe(20);
    expect(dispatches()[19]?.length).toBe(50);
  });

  // An idle tick is the common case, so it is one step: 2 executions, not 3.
  it("sends nothing when no job is due, in a single step", async () => {
    claimDueMock.mockResolvedValue([]);
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(sendMock).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(stepIds(step)).toEqual(["claim-due-jobs"]);
    expect(summary).toEqual({
      claimed: 0,
      dispatched: 0,
      failedNoConnections: 0,
      dispatchErrors: 0,
    });
  });

  // Review Focus 3: a failed send must not strand the other chunks. The jobs of the
  // failed send stay in_progress; the stuck-job reconciler finalizes them.
  it("a rejected send fails only its own chunk: the other chunks are still sent", async () => {
    claimDueMock.mockResolvedValue(claimed(120));
    sendMock.mockImplementation(async (events: SentPayload) => {
      if (events.some((e) => e.id === "publish-job-50")) throw new Error("inngest unavailable");
      return { ids: [] };
    });
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(dispatches().length).toBe(3);
    expect(summary).toEqual({
      claimed: 120,
      dispatched: 70,
      failedNoConnections: 0,
      dispatchErrors: 50,
    });
  });

  // 2026-11-01 scale audit (jobs H6), ruling R21: a transient DB error is retried
  // inline (500 ms, then 2 s) before the job is left to the reconciler.
  it("retries a job that throws while materializing, then dispatches it", async () => {
    vi.useFakeTimers();
    claimDueMock.mockResolvedValue(claimed(4));
    let calls = 0;
    prepareDeferredMock.mockImplementation(async (id: string) => {
      if (id === "job-1" && (calls += 1) === 1) throw new Error("pool timeout");
      return okFor(id);
    });
    const step = fakeStep();

    const promise = runScanner(step);
    await vi.runAllTimersAsync();
    const summary = await promise;

    expect(dispatches()[0]?.map((e) => e.id)).toEqual([
      "publish-job-0",
      "publish-job-1",
      "publish-job-2",
      "publish-job-3",
    ]);
    expect(summary).toEqual({
      claimed: 4,
      dispatched: 4,
      failedNoConnections: 0,
      dispatchErrors: 0,
    });
  });

  it("a job that throws every attempt is counted and does not hold back the rest of its chunk", async () => {
    vi.useFakeTimers();
    claimDueMock.mockResolvedValue(claimed(4));
    prepareDeferredMock.mockImplementation(async (id: string) => {
      if (id === "job-1") throw new Error("pool timeout");
      return okFor(id);
    });
    const step = fakeStep();

    const promise = runScanner(step);
    await vi.runAllTimersAsync();
    const summary = await promise;

    expect(dispatches()[0]?.map((e) => e.id)).toEqual([
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

  it("a chunk step that fails outright counts its whole chunk and the next chunk still runs", async () => {
    claimDueMock.mockResolvedValue(claimed(60));
    const step = fakeStep();
    step.run.mockImplementation(async (id: string, cb: () => unknown) => {
      if (id === "materialize-dispatch-batch-0") throw new Error("step exhausted its retries");
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    });

    const summary = await runScanner(step);

    expect(dispatches().map((events) => events.length)).toEqual([10]);
    expect(summary).toEqual({
      claimed: 60,
      dispatched: 10,
      failedNoConnections: 0,
      dispatchErrors: 50,
    });
  });

  // 2026-11-01 scale audit (jobs H6), ruling R20: nothing caps a caption, so 50
  // events can be 5 MB. The old pair of steps carried the events in a memoized
  // output (4 MiB limit) and sent them in one request; one chunk step now returns
  // only counts and sends bounded sub-batches.
  it("50 events of 100 KB are sent in bounded sub-batches and the step output stays tiny", async () => {
    claimDueMock.mockResolvedValue(claimed(50));
    prepareDeferredMock.mockImplementation(async (id: string) =>
      okFor(id, `${id} ${"c".repeat(100_000)}`),
    );
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(summary).toMatchObject({ claimed: 50, dispatched: 50, dispatchErrors: 0 });
    expect(dispatches().length).toBeGreaterThanOrEqual(5);
    expect(dispatches().flat().length).toBe(50);
    for (const events of dispatches()) {
      expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThanOrEqual(MAX_DISPATCH_BYTES);
    }
    const chunkOutput = await step.run.mock.results[
      stepIds(step).indexOf("materialize-dispatch-batch-0")
    ]?.value;
    expect(JSON.stringify(chunkOutput).length).toBeLessThan(2_000);
    expect(JSON.stringify(chunkOutput)).not.toMatch(/caption/i);
  });

  it("one rejected sub-batch of an oversize chunk counts only its own jobs", async () => {
    claimDueMock.mockResolvedValue(claimed(20));
    prepareDeferredMock.mockImplementation(async (id: string) =>
      okFor(id, id === "job-5" ? "x".repeat(1_500_000) : "small"),
    );
    sendMock.mockImplementation(async (events: SentPayload) => {
      if (events.some((e) => e.id === "publish-job-5")) throw new Error("event too large");
      return { ids: [] };
    });
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(dispatches().length).toBe(3);
    expect(summary).toEqual({
      claimed: 20,
      dispatched: 19,
      failedNoConnections: 0,
      dispatchErrors: 1,
    });
  });
});

describe("scheduledPostScanner - stuck-job reconcile", () => {
  // The reconcile shares the claim's step to save an execution per tick. It runs
  // FIRST: a step that dies after the claim's UPDATE but before it returns loses
  // the claimed ids (they sit in_progress until the 2 h reconcile fails them), so
  // nothing slower may follow the claim inside the step.
  it("reconciles stuck jobs inside the claim step, before claiming", async () => {
    claimDueMock.mockResolvedValue(claimed(2));
    const step = fakeStep();

    await runScanner(step);

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(claimDueMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.invocationCallOrder[0]).toBeLessThan(
      claimDueMock.mock.invocationCallOrder[0]!,
    );
    expect(stepIds(step)[0]).toBe("claim-due-jobs");
  });

  // Recovery must never hold up publishing: a reconcile that throws on every
  // attempt would otherwise fail the claim step and stop scheduled posts.
  it("a failing reconcile is logged and the due posts are still claimed and sent", async () => {
    reconcileMock.mockRejectedValue(new Error("reconcile query failed"));
    claimDueMock.mockResolvedValue(claimed(3));
    const step = fakeStep();

    const summary = await runScanner(step);

    expect(summary).toEqual({
      claimed: 3,
      dispatched: 3,
      failedNoConnections: 0,
      dispatchErrors: 0,
    });
    expect(console.error).toHaveBeenCalled();
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

    expect(stepIds(step)).toEqual(["claim-due-jobs", "materialize-dispatch-batch-0"]);
    expect(dispatches().map((events) => events.map((e) => e.id))).toEqual([["publish-job-a"]]);
    expect(notifyIds(step)).toEqual(["notify-noconn-batch-0"]);
    expect(notifyPayload(step, 0)).toEqual([
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

    expect(sendMock).not.toHaveBeenCalled();
    expect(notifyIds(step)).toEqual(["notify-noconn-batch-0"]);
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
