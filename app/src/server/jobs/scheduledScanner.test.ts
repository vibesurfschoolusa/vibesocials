import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. scheduledScanner.ts imports `@/lib/db` at
// module scope, so mock it before the import below (mirrors the route tests).
const {
  queryRawMock,
  findManyMock,
  findUniqueMock,
  updateManyMock,
  resultFindManyMock,
  resultUpdateManyMock,
  prepareDeferredMock,
} = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateManyMock: vi.fn(),
  resultFindManyMock: vi.fn(),
  resultUpdateManyMock: vi.fn(),
  prepareDeferredMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: queryRawMock,
    postJob: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
    postJobResult: {
      findMany: resultFindManyMock,
      updateMany: resultUpdateManyMock,
    },
  },
}));
// The deferred-dispatch DB work is stubbed (posting.test.ts covers it); the REAL
// event builder stays in place so the events' ids and shape are asserted for real.
vi.mock("@/server/jobs/posting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/posting")>()),
  prepareDeferredPostJobDispatch: prepareDeferredMock,
}));

import {
  claimDueScheduledJobs,
  DUE_SCAN_BATCH,
  MATERIALIZE_CHUNK_SIZE,
  MATERIALIZE_RETRY_DELAYS_MS,
  MAX_DISPATCH_BYTES,
  materializeAndDispatchChunk,
  materializeClaimedJobs,
  reconcileStuckInProgressJobs,
  splitEventsBySize,
  STUCK_IN_PROGRESS_MS,
} from "./scheduledScanner";
import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

const NOW = new Date("2026-07-10T12:00:00.000Z");

beforeEach(() => {
  queryRawMock.mockReset();
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  updateManyMock.mockReset();
  resultFindManyMock.mockReset();
  resultUpdateManyMock.mockReset();
  prepareDeferredMock.mockReset();
});

// 2026-11-01 scale audit (jobs H6): a 500-post burst used to take minutes to
// dispatch (2 sequential steps per job, 100 claimed per tick). One tick now claims
// up to 1000 and materializes them in chunks of 50.
describe("scanner batch constants", () => {
  it("claims up to 1000 due jobs per tick and materializes 50 per step", () => {
    expect(DUE_SCAN_BATCH).toBe(1000);
    expect(MATERIALIZE_CHUNK_SIZE).toBe(50);
  });

  // R20 / R21: events are sent in sub-batches of at most 1 MiB, and a job whose
  // materialize throws is retried inline after 500 ms and then 2 s.
  it("bounds a send at 1 MiB and retries a throwing materialize after 500 ms then 2 s", () => {
    expect(MAX_DISPATCH_BYTES).toBe(1_048_576);
    expect([...MATERIALIZE_RETRY_DELAYS_MS]).toEqual([500, 2000]);
  });
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
          // A result waiting out a platform limit keeps its job alive (below).
          results: {
            none: {
              status: "pending",
              deferredUntil: { gte: new Date(NOW.getTime() - STUCK_IN_PROGRESS_MS) },
            },
          },
        },
      }),
    );
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "stuck-1", status: "in_progress" },
      data: { status: "failed" },
    });
  });

  // Review Focus 2 (2026-11-01 scale audit, platform limits): a YouTube result
  // deferred ~20 h, while the job's other platforms already finished, leaves the
  // job `in_progress` with an old heartbeat for far longer than 2 h. The run is
  // asleep, not dead: such a job must never be a reconcile candidate.
  describe("a job with a result deferred to a platform limit (Review Focus 2)", () => {
    it("is excluded from the candidates until 2 h after its deferral ends", async () => {
      findManyMock.mockResolvedValue([]);

      await reconcileStuckInProgressJobs(NOW);

      const { where } = findManyMock.mock.calls[0][0] as {
        where: { results: { none: { status: string; deferredUntil: { gte: Date } } } };
      };
      // `none` of the job's results is pending with deferredUntil >= now - 2 h: a
      // deferral still in the future (or ended less than 2 h ago, the grace for the
      // run to wake and claim it) protects the job.
      expect(where.results.none.status).toBe("pending");
      expect(where.results.none.deferredUntil.gte).toEqual(new Date("2026-07-10T10:00:00.000Z"));
    });

    it("honours a custom maxAgeMs for both the heartbeat and the deferral cutoff", async () => {
      findManyMock.mockResolvedValue([]);

      await reconcileStuckInProgressJobs(NOW, 50, 60_000);

      const cutoff = new Date(NOW.getTime() - 60_000);
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "in_progress",
            updatedAt: { lt: cutoff },
            results: { none: { status: "pending", deferredUntil: { gte: cutoff } } },
          },
        }),
      );
    });
  });

  it("fails pending results then recomputes terminal status", async () => {
    findManyMock.mockResolvedValue([{ id: "stuck-2" }]);
    resultFindManyMock
      .mockResolvedValueOnce([
        { id: "r1", status: "pending", claimRunId: null },
        { id: "r2", status: "success", claimRunId: "run-1" },
      ])
      .mockResolvedValueOnce([
        { status: "failed" },
        { status: "success" },
      ]);
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    updateManyMock.mockResolvedValue({ count: 1 });

    const out = await reconcileStuckInProgressJobs(NOW);

    expect(out.reconciled).toBe(1);
    expect(resultFindManyMock).toHaveBeenNthCalledWith(1, {
      where: { postJobId: "stuck-2" },
      select: { id: true, status: true, claimRunId: true },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["r1"] }, status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "PUBLISH_STALLED",
        errorMessage: "Publish did not complete (stalled). You can retry this platform.",
      },
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "stuck-2", status: "in_progress" },
      data: { status: "completed" },
    });
  });

  // 2026-11-01 scale audit (jobs H6): a pending result with a claim had its
  // platform step start - the call may have reached the platform before the run
  // died. "Stalled, retry it" would invite a second post, so a claimed row is
  // marked PUBLISH_UNCONFIRMED ("may already be live"); only an unclaimed row,
  // which provably never reached the platform, is PUBLISH_STALLED.
  it("marks a stuck job's claimed pending result PUBLISH_UNCONFIRMED and its unclaimed one PUBLISH_STALLED", async () => {
    findManyMock.mockResolvedValue([{ id: "stuck-3" }]);
    resultFindManyMock
      .mockResolvedValueOnce([
        { id: "r-claimed", status: "pending", claimRunId: "run-1" },
        { id: "r-unclaimed", status: "pending", claimRunId: null },
        { id: "r-done", status: "success", claimRunId: "run-1" },
      ])
      .mockResolvedValueOnce([
        { status: "failed" },
        { status: "failed" },
        { status: "success" },
      ]);
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    updateManyMock.mockResolvedValue({ count: 1 });

    const out = await reconcileStuckInProgressJobs(NOW);

    expect(out.reconciled).toBe(1);
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(2);
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["r-claimed"] }, status: "pending", claimRunId: { not: null } },
      data: {
        status: "failed",
        errorCode: "PUBLISH_UNCONFIRMED",
        errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
      },
    });
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["r-unclaimed"] }, status: "pending", claimRunId: null },
      data: {
        status: "failed",
        errorCode: "PUBLISH_STALLED",
        errorMessage: "Publish did not complete (stalled). You can retry this platform.",
      },
    });
  });

  it("skips the write for a kind that has no pending rows", async () => {
    findManyMock.mockResolvedValue([{ id: "stuck-4" }]);
    resultFindManyMock
      .mockResolvedValueOnce([{ id: "r-claimed", status: "pending", claimRunId: "run-1" }])
      .mockResolvedValueOnce([{ status: "failed" }]);
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    updateManyMock.mockResolvedValue({ count: 1 });

    await reconcileStuckInProgressJobs(NOW);

    expect(resultUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(resultUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["r-claimed"] }, status: "pending", claimRunId: { not: null } },
      }),
    );
  });
});

/** A prepared-dispatch result for `id`, shaped like prepareDeferredPostJobDispatch's. */
function okFor(id: string, baseCaption = `caption ${id}`) {
  return {
    ok: true as const,
    event: {
      postJobId: id,
      userId: `user-${id}`,
      workspaceId: `ws-${id}`,
      mediaItemId: `media-${id}`,
      baseCaption,
      perPlatformOverrides: null,
    },
  };
}

/** `count` ids: job-0 ... job-<count-1>. */
const ids = (count: number) => Array.from({ length: count }, (_, i) => `job-${i}`);

describe("materializeClaimedJobs", () => {
  /** Resolves at once; records the waits it was asked for. */
  const sleep = vi.fn<(ms: number) => Promise<void>>();

  beforeEach(() => {
    sleep.mockReset();
    sleep.mockResolvedValue(undefined);
    // A job that throws is logged (and surfaced); keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("builds a scheduled (immediate: false) publish event with a stable id per ok job and isolates a job that keeps throwing", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("pool timeout");
      return okFor(id);
    });

    const out = await materializeClaimedJobs(["a", "b", "c"], sleep);

    expect(out.publishEvents.map((e) => e.id)).toEqual(["publish-a", "publish-c"]);
    expect(out.publishEvents.every((e) => e.name === "post/publish.requested")).toBe(true);
    expect(out.publishEvents.every((e) => e.data.immediate === false)).toBe(true);
    // The event carries the job's workspace, so the per-workspace concurrency key resolves.
    expect(out.publishEvents[0]?.data).toMatchObject({
      postJobId: "a",
      userId: "user-a",
      workspaceId: "ws-a",
    });
    // The failed job stays in_progress for the stuck-job reconciler.
    expect(out.errorIds).toEqual(["b"]);
    expect(out.noConnections).toEqual([]);
    expect(out.notFound).toEqual([]);
    // a once, b three times (1 + 2 retries), c once.
    expect(prepareDeferredMock).toHaveBeenCalledTimes(5);
  });

  it("puts a NO_CONNECTIONS job in noConnections with its owner's userId", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) =>
      id === "n" ? { ok: false, reason: "NO_CONNECTIONS" } : okFor(id),
    );
    findUniqueMock.mockResolvedValue({ userId: "owner-1" });

    const out = await materializeClaimedJobs(["a", "n"], sleep);

    expect(out.noConnections).toEqual([{ postJobId: "n", userId: "owner-1" }]);
    expect(out.publishEvents.map((e) => e.id)).toEqual(["publish-a"]);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "n" },
      select: { userId: true },
    });
  });

  it("puts a NOT_FOUND job in notFound and sends nothing for it", async () => {
    prepareDeferredMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    const out = await materializeClaimedJobs(["gone"], sleep);

    expect(out).toEqual({ publishEvents: [], noConnections: [], notFound: ["gone"], errorIds: [] });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("reports an owner lookup that keeps throwing as an error, and one deleted since as not found", async () => {
    prepareDeferredMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });
    findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "x") throw new Error("pool timeout");
      return null;
    });

    const out = await materializeClaimedJobs(["x", "y"], sleep);

    expect(out.errorIds).toEqual(["x"]);
    expect(out.notFound).toEqual(["y"]);
    expect(out.noConnections).toEqual([]);
  });

  it("returns an empty batch for no ids without touching the database", async () => {
    const out = await materializeClaimedJobs([], sleep);

    expect(out).toEqual({ publishEvents: [], noConnections: [], notFound: [], errorIds: [] });
    expect(prepareDeferredMock).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  // 2026-11-01 scale audit (jobs H6), ruling R21: the per-job try/catch swallows a
  // throw so one bad job cannot strand its chunk, which also means no Inngest step
  // retry ever heals a transient pool timeout. The job is retried inline instead.
  describe("inline retries of a throwing job", () => {
    it("dispatches a job that throws once and then succeeds, and does not report it as an error", async () => {
      prepareDeferredMock
        .mockRejectedValueOnce(new Error("Timed out fetching a new connection from the pool"))
        .mockImplementation(async (id: string) => okFor(id));

      const out = await materializeClaimedJobs(["a"], sleep);

      expect(out.publishEvents.map((e) => e.id)).toEqual(["publish-a"]);
      expect(out.errorIds).toEqual([]);
      expect(prepareDeferredMock).toHaveBeenCalledTimes(2);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500]);
    });

    it("gives up on a job that throws 3 times: it lands in errorIds, after waits of 500 ms and 2000 ms", async () => {
      prepareDeferredMock.mockRejectedValue(new Error("pool timeout"));

      const out = await materializeClaimedJobs(["a"], sleep);

      expect(out.errorIds).toEqual(["a"]);
      expect(out.publishEvents).toEqual([]);
      expect(prepareDeferredMock).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 2000]);
    });

    it("succeeds on the third attempt after both waits", async () => {
      prepareDeferredMock
        .mockRejectedValueOnce(new Error("blip 1"))
        .mockRejectedValueOnce(new Error("blip 2"))
        .mockImplementation(async (id: string) => okFor(id));

      const out = await materializeClaimedJobs(["a"], sleep);

      expect(out.publishEvents.map((e) => e.id)).toEqual(["publish-a"]);
      expect(out.errorIds).toEqual([]);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 2000]);
    });

    it("retries the owner lookup of a NO_CONNECTIONS job too", async () => {
      prepareDeferredMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });
      findUniqueMock
        .mockRejectedValueOnce(new Error("pool timeout"))
        .mockResolvedValueOnce({ userId: "owner-1" });

      const out = await materializeClaimedJobs(["n"], sleep);

      expect(out.noConnections).toEqual([{ postJobId: "n", userId: "owner-1" }]);
      expect(out.errorIds).toEqual([]);
    });

    it("does not wait when every job succeeds", async () => {
      prepareDeferredMock.mockImplementation(async (id: string) => okFor(id));

      await materializeClaimedJobs(["a", "b"], sleep);

      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

// 2026-11-01 scale audit (jobs H6), ruling R20: an event's size is set by user text
// that nothing caps (baseCaption, the per-platform override values). A send batches
// events up to MAX_DISPATCH_BYTES, so one huge caption can neither fail the send of
// 49 other users' posts nor bloat a memoized step output.
describe("splitEventsBySize", () => {
  const sized = (id: string, chars: number) => ({ id, pad: "x".repeat(chars) });
  const bytesOf = (events: unknown[]) => JSON.stringify(events).length;

  it("returns no batches for no events", () => {
    expect(splitEventsBySize([], 1000)).toEqual([]);
  });

  it("keeps events that fit together in one batch, in order", () => {
    const events = [sized("a", 10), sized("b", 10), sized("c", 10)];

    expect(splitEventsBySize(events, 10_000)).toEqual([events]);
  });

  it("starts a new batch before a batch would serialize past the bound", () => {
    const events = Array.from({ length: 10 }, (_, i) => sized(`e${i}`, 100));
    const bound = bytesOf(events.slice(0, 4)); // exactly 4 events fit

    const batches = splitEventsBySize(events, bound);

    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
    expect(batches.flat().map((e) => e.id)).toEqual(events.map((e) => e.id));
    for (const batch of batches) expect(bytesOf(batch)).toBeLessThanOrEqual(bound);
  });

  it("sends an event bigger than the bound alone", () => {
    const small = sized("small", 10);
    const big = sized("big", 5000);

    const batches = splitEventsBySize([small, small, big, small], 1000);

    expect(batches.map((b) => b.map((e) => e.id))).toEqual([
      ["small", "small"],
      ["big"],
      ["small"],
    ]);
  });

  it("measures bytes, not characters, so a multi-byte caption cannot slip under the bound", () => {
    // 300 CJK characters are 300 UTF-16 units but about 900 UTF-8 bytes.
    const cjk = { id: "cjk", pad: "字".repeat(300) };
    const ascii = sized("ascii", 300);

    expect(splitEventsBySize([cjk, cjk], 1000).length).toBe(2);
    expect(splitEventsBySize([ascii, ascii], 1000).length).toBe(1);
  });

  it("defaults to MAX_DISPATCH_BYTES", () => {
    const sixtyPercent = sized("big", Math.floor(MAX_DISPATCH_BYTES * 0.6));

    expect(splitEventsBySize([sixtyPercent, sixtyPercent]).length).toBe(2);
    expect(splitEventsBySize([sixtyPercent]).length).toBe(1);
  });
});

describe("materializeAndDispatchChunk", () => {
  const sleep = vi.fn<(ms: number) => Promise<void>>();
  const send = vi.fn<(events: unknown[]) => Promise<unknown>>();
  const sentIds = (call: number) =>
    (send.mock.calls[call]?.[0] as Array<{ id: string }>).map((e) => e.id);

  beforeEach(() => {
    sleep.mockReset();
    sleep.mockResolvedValue(undefined);
    send.mockReset();
    send.mockResolvedValue({ ids: [] });
    prepareDeferredMock.mockImplementation(async (id: string) => okFor(id));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("materializes the chunk and sends its events in one batch", async () => {
    const out = await materializeAndDispatchChunk(ids(3), { send, sleep });

    expect(send).toHaveBeenCalledTimes(1);
    expect(sentIds(0)).toEqual(["publish-job-0", "publish-job-1", "publish-job-2"]);
    expect(out).toEqual({
      dispatched: 3,
      dispatchErrors: 0,
      noConnections: [],
      notFound: [],
      errorIds: [],
    });
  });

  it("sends nothing for a chunk without an ok job", async () => {
    prepareDeferredMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    const out = await materializeAndDispatchChunk(ids(2), { send, sleep });

    expect(send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dispatched: 0, dispatchErrors: 0, notFound: ["job-0", "job-1"] });
  });

  // One ~1.5 MB event among 49 small ones (a caption nothing caps). It would push a
  // single 50-event send past any request cap; bounded sub-batches send it alone.
  it("sends a chunk with one ~1.5 MB event and 49 small ones in at least 2 sub-batches, the big event alone", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) =>
      okFor(id, id === "job-10" ? "x".repeat(1_500_000) : "small"),
    );

    const out = await materializeAndDispatchChunk(ids(50), { send, sleep });

    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    const bigCall = send.mock.calls.findIndex(([events]) =>
      (events as Array<{ id: string }>).some((e) => e.id === "publish-job-10"),
    );
    expect(sentIds(bigCall)).toEqual(["publish-job-10"]);
    // Every event is sent, once, in order.
    expect(send.mock.calls.flatMap((_c, i) => sentIds(i))).toEqual(
      ids(50).map((id) => `publish-${id}`),
    );
    for (const [events] of send.mock.calls) {
      const batch = events as unknown[];
      if (batch.length > 1) {
        expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_DISPATCH_BYTES);
      }
    }
    expect(out).toMatchObject({ dispatched: 50, dispatchErrors: 0 });
  });

  it("a rejected sub-batch leaves the other sub-batches sent, and only its jobs are dispatchErrors", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) =>
      okFor(id, id === "job-10" ? "x".repeat(1_500_000) : "small"),
    );
    send.mockImplementation(async (events: unknown[]) => {
      if ((events as Array<{ id: string }>).some((e) => e.id === "publish-job-10")) {
        throw new Error("inngest rejected the event");
      }
      return { ids: [] };
    });

    const out = await materializeAndDispatchChunk(ids(50), { send, sleep });

    expect(send).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({ dispatched: 49, dispatchErrors: 1, errorIds: [] });
  });

  it("counts a job that failed to materialize as an error id, not as a dispatch error", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) => {
      if (id === "job-1") throw new Error("pool timeout");
      return okFor(id);
    });

    const out = await materializeAndDispatchChunk(ids(3), { send, sleep });

    expect(sentIds(0)).toEqual(["publish-job-0", "publish-job-2"]);
    expect(out).toEqual({
      dispatched: 2,
      dispatchErrors: 0,
      noConnections: [],
      notFound: [],
      errorIds: ["job-1"],
    });
  });

  it("returns the NO_CONNECTIONS owners for the notification send", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) =>
      id === "job-1" ? { ok: false, reason: "NO_CONNECTIONS" } : okFor(id),
    );
    findUniqueMock.mockResolvedValue({ userId: "owner-1" });

    const out = await materializeAndDispatchChunk(ids(3), { send, sleep });

    expect(out.noConnections).toEqual([{ postJobId: "job-1", userId: "owner-1" }]);
    expect(out.dispatched).toBe(2);
  });

  // The result is the step's memoized output. It must stay small however big the
  // captions are: Inngest caps a step output at 4 MiB and a run's state at 32 MiB.
  it("returns only counts and ids: no caption, baseCaption or perPlatformOverrides, however large the events", async () => {
    prepareDeferredMock.mockImplementation(async (id: string) =>
      okFor(id, `SECRET-CAPTION-TEXT ${"y".repeat(100_000)}`),
    );
    prepareDeferredMock.mockImplementationOnce(async () => ({ ok: false, reason: "NO_CONNECTIONS" }));
    findUniqueMock.mockResolvedValue({ userId: "owner-1" });

    const out = await materializeAndDispatchChunk(ids(50), { send, sleep });

    expect(Object.keys(out).sort()).toEqual(
      ["dispatchErrors", "dispatched", "errorIds", "noConnections", "notFound"].sort(),
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/caption/i);
    expect(serialized).not.toContain("perPlatformOverrides");
    expect(serialized.length).toBeLessThan(5_000);
    // The 49 events were nevertheless all sent, in bounded sub-batches.
    expect(send.mock.calls.flatMap((_c, i) => sentIds(i)).length).toBe(49);
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("materializeClaimedJobs - a post without a file", () => {
  it("carries a text post's event through unchanged in shape", async () => {
    const event = {
      postJobId: "t",
      userId: "user-t",
      workspaceId: "ws-t",
      mediaItemId: null,
      baseCaption: "Wind is onshore",
      perPlatformOverrides: null,
    };
    prepareDeferredMock.mockResolvedValue({ ok: true, event });

    const out = await materializeClaimedJobs(["t"], vi.fn(async () => undefined));

    expect(out.publishEvents).toEqual([
      { id: "publish-t", name: "post/publish.requested", data: { ...event, immediate: false } },
    ]);
  });
});
