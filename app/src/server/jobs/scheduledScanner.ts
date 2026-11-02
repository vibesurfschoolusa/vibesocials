import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";
import {
  buildPublishEvent,
  prepareDeferredPostJobDispatch,
  type PublishEvent,
} from "@/server/jobs/posting";

/**
 * Roadmap Phase 5 — DB-backed cron due-scanner claim logic (§6.2).
 *
 * The category-defining scheduler is a DB source of truth + a cron that claims
 * due jobs, NOT a weeks-long `step.sleepUntil` (which is a function-versioning
 * landmine and makes cancel/edit a run-teardown race). Extracted from the
 * Inngest function so the atomic-claim logic is unit-testable with a mocked
 * prisma, mirroring the route-test convention.
 */

/**
 * Max due jobs claimed per scan; the every-minute cadence drains any backlog.
 *
 * 2026-11-01 scale audit (jobs H6): 1000, up from 100, so a 500-post burst is
 * claimed by ONE tick. The old two-steps-per-job dispatch made that unaffordable
 * (2,002 steps against Inngest's 1,000-step run limit,
 * https://www.inngest.com/docs/usage-limits/inngest); the scanner now materializes
 * and sends in chunks of {@link MATERIALIZE_CHUNK_SIZE}, one step per chunk, so a
 * full tick is 2 + 20 steps plus at most 20 notification sends.
 */
export const DUE_SCAN_BATCH = 1000;

/**
 * Claimed jobs materialized and dispatched per `materialize-dispatch-batch-<i>`
 * step. 2026-11-01 scale audit (jobs H6): this bounds the DB work and wall-clock
 * time of one step (50 jobs, a few queries each, plus the inline retries of
 * {@link MATERIALIZE_RETRY_DELAYS_MS}, well inside the route's 300 s) and keeps a
 * full tick of {@link DUE_SCAN_BATCH} at 2 + 20 chunk steps (plus at most 20
 * notification sends) against Inngest's 1,000 steps per run
 * (https://www.inngest.com/docs/usage-limits/inngest). It does NOT bound payload
 * size: captions are user text that nothing caps, so that is the job of
 * {@link MAX_DISPATCH_BYTES}, and the step returns only counts and ids.
 */
export const MATERIALIZE_CHUNK_SIZE = 50;

/**
 * Largest serialized batch of publish events sent in one `inngest.send`.
 * 2026-11-01 scale audit (jobs H6, ruling R20): a single event is capped at 3 MiB
 * on Pro and a send at 5,000 events (https://www.inngest.com/docs/usage-limits/inngest);
 * the cap on the TOTAL request size is unconfirmed, so a send stays at 1 MiB. Events
 * are packed greedily up to this bound, and an event bigger than the bound is sent
 * alone, so one huge caption can fail only its own send, never the other posts of
 * its chunk.
 */
export const MAX_DISPATCH_BYTES = 1_048_576;

/**
 * Waits before the 2nd and 3rd attempt at a job whose materialize threw
 * (2026-11-01 scale audit, jobs H6, ruling R21). A transient pool timeout or DB
 * blip heals within these; a job still failing after the 3rd attempt is left
 * `in_progress` for the stuck-job reconciler. Inngest step retries are deliberately
 * not used for this: their backoff, with the cron's `singleton: skip`, would stall
 * the minute-by-minute scanner.
 */
export const MATERIALIZE_RETRY_DELAYS_MS = [500, 2000] as const;

/**
 * How long a job may sit in `in_progress` before the reconcilers assume the
 * publish run died without finalizing (materialize crash, deploy mid-run, etc.).
 */
export const STUCK_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;

/** Max stuck jobs reconciled per scan. */
export const STUCK_RECONCILE_BATCH = 50;

/**
 * Atomically claim scheduled jobs whose `scheduledFor` has arrived.
 *
 * ONE statement (2026-11-01 audit): the inner SELECT locks the due rows with
 * `FOR UPDATE SKIP LOCKED` and the UPDATE flips exactly those to
 * `in_progress`, returning their ids. It either commits as a whole or not at
 * all, so a failure can never leave rows claimed-but-unreported — the old
 * find-then-flip-each loop stranded every row it had already flipped when it
 * threw mid-loop (the step retry re-queries only `scheduled`). A concurrent
 * scanner skips rows this one holds; a `cancel`/`PATCH` that already moved a
 * row out of `scheduled` makes it ineligible. No job is ever double-claimed
 * and thus never double-posted.
 *
 * Never claims a submitted-but-unapproved job (`submittedForApprovalAt` set,
 * `approvedAt` null): the old approval bypass could leave such rows
 * `scheduled`, and the cron must not publish unreviewed posts (controller
 * ruling R6; migration `20261101120000_rehold_unapproved_scheduled` re-holds
 * the existing ones as drafts).
 *
 * Timestamps: Prisma binds a JS Date as `timestamptz`, while DateTime columns
 * are `timestamp(3)` holding UTC wall-clock time — so the bound `now` is
 * converted `AT TIME ZONE 'UTC'` instead of letting Postgres cast via the
 * session TimeZone.
 *
 * Returns the claimed ids, oldest `scheduledFor` first. ≤1-minute latency is
 * fine for a social scheduler.
 */
export async function claimDueScheduledJobs(
  now: Date,
  take: number = DUE_SCAN_BATCH,
): Promise<string[]> {
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    WITH claimed AS (
      UPDATE "PostJob"
      SET "status" = 'in_progress'::"PostJobStatus",
          "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "PostJob"
        WHERE "status" = 'scheduled'::"PostJobStatus"
          AND "scheduledFor" <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND NOT ("submittedForApprovalAt" IS NOT NULL AND "approvedAt" IS NULL)
        ORDER BY "scheduledFor" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "scheduledFor"
    )
    SELECT "id" FROM claimed ORDER BY "scheduledFor" ASC`;

  return claimed.map((row) => row.id);
}

/** What {@link materializeClaimedJobs} collects from a chunk of claimed jobs. */
export interface MaterializedBatch {
  /** `post/publish.requested` events (stable id, `immediate: false`), one per ok job. */
  publishEvents: PublishEvent[];
  /** Jobs marked `failed` for lack of an eligible connection, with their owner to notify. */
  noConnections: Array<{ postJobId: string; userId: string }>;
  /** Claimed jobs that no longer exist (deleted between the claim and the materialize). */
  notFound: string[];
  /** Jobs whose materialize threw on every attempt. They stay `in_progress` for the stuck-job reconciler. */
  errorIds: string[];
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, retrying it after each wait of {@link MATERIALIZE_RETRY_DELAYS_MS}
 * if it throws; rethrow the last error once the waits are used up. `attempt` must
 * be idempotent (materializing a job is).
 */
async function withMaterializeRetries<T>(
  attempt: () => Promise<T>,
  sleep: Sleep,
  postJobId: string,
): Promise<T> {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      const delayMs = MATERIALIZE_RETRY_DELAYS_MS[tried];
      if (delayMs === undefined) throw error;
      logger.warn("[Inngest] Scheduled materialize failed, retrying", { postJobId, tried, delayMs, error });
      await sleep(delayMs);
    }
  }
}

/**
 * Materialize a chunk of claimed jobs: create each job's per-platform results from
 * the connections that exist now and build its publish event, exactly as the
 * per-job step did.
 *
 * Jobs are handled one by one, each in its own try/catch (review Minor #1): one job
 * that throws (a DB blip) must not strand the rest of the chunk, which are already
 * `in_progress` and are never re-claimed (the claim only re-queries `scheduled`). A
 * job that throws is retried inline ({@link MATERIALIZE_RETRY_DELAYS_MS}, ruling
 * R21) because that swallowed throw means no Inngest step retry ever heals it; one
 * that still throws goes to `errorIds` and stays `in_progress` for the reconciler.
 * Everything here is idempotent (`prepareDeferredPostJobDispatch` creates results
 * only when none exist), so a retry, or a re-run of the whole chunk (a scan that
 * straddles a deploy), duplicates no rows; the stable event id then dedupes the
 * second publish (Review Focus 3).
 *
 * The events can be large and are NOT step output: only
 * {@link materializeAndDispatchChunk} calls this, and it returns counts and ids.
 *
 * @param sleep injectable so tests do not wait out the retry delays.
 */
export async function materializeClaimedJobs(
  postJobIds: string[],
  sleep: Sleep = defaultSleep,
): Promise<MaterializedBatch> {
  const batch: MaterializedBatch = {
    publishEvents: [],
    noConnections: [],
    notFound: [],
    errorIds: [],
  };

  for (const postJobId of postJobIds) {
    try {
      await withMaterializeRetries(
        async () => {
          const prep = await prepareDeferredPostJobDispatch(postJobId);
          if (prep.ok) {
            // The scanner is not "Post now": `immediate: false` keeps the run at
            // priority 0 behind user-triggered publishes.
            batch.publishEvents.push(buildPublishEvent(prep.event, { immediate: false }));
          } else if (prep.reason === "NO_CONNECTIONS") {
            // The job is already marked failed; look up whom to tell.
            const owner = await prisma.postJob.findUnique({
              where: { id: postJobId },
              select: { userId: true },
            });
            if (owner) {
              batch.noConnections.push({ postJobId, userId: owner.userId });
            } else {
              batch.notFound.push(postJobId);
            }
          } else {
            batch.notFound.push(postJobId);
          }
        },
        sleep,
        postJobId,
      );
    } catch (error) {
      logger.error("[Inngest] Scheduled materialize failed", { postJobId, error });
      batch.errorIds.push(postJobId);
    }
  }

  return batch;
}

/**
 * Pack events, in order, into batches whose serialized size
 * (`JSON.stringify(batch)`, in UTF-8 bytes) stays within `maxBytes`. An event that
 * alone exceeds `maxBytes` gets a batch of its own. Pure.
 */
export function splitEventsBySize<T>(events: T[], maxBytes: number = MAX_DISPATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 2; // the enclosing "[]"
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const addedBytes = batch.length === 0 ? eventBytes : eventBytes + 1; // + the comma
    if (batch.length > 0 && batchBytes + addedBytes > maxBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batchBytes += batch.length === 0 ? eventBytes : eventBytes + 1;
    batch.push(event);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * The step output of `materialize-dispatch-batch-<i>`: counts and ids only. No
 * event payloads, so no caption text, and a step output (4 MiB) or the run's
 * memoized state (32 MiB) can never be exhausted by user text.
 */
export interface ChunkDispatchResult {
  /** Publish events accepted by Inngest. */
  dispatched: number;
  /** Publish events whose sub-batch send was rejected. Their jobs stay `in_progress`. */
  dispatchErrors: number;
  noConnections: Array<{ postJobId: string; userId: string }>;
  notFound: string[];
  /** Jobs whose materialize threw on every attempt (see {@link MaterializedBatch}). */
  errorIds: string[];
}

/**
 * One scanner chunk (the body of a `materialize-dispatch-batch-<i>` step):
 * {@link materializeClaimedJobs}, then send the publish events with `deps.send`
 * (`inngest.send`) in sub-batches bounded by {@link MAX_DISPATCH_BYTES}.
 *
 * 2026-11-01 scale audit (jobs H6, ruling R20): materialize and send share ONE step
 * so the events never become memoized step output. Each sub-batch send has its own
 * try/catch: a rejected one is counted in `dispatchErrors` and its jobs stay
 * `in_progress` for the reconciler, as before; the other sub-batches still send. A
 * re-run of the step is safe: materialize is idempotent and the event ids
 * (`publish-<postJobId>`) are stable, with `idempotency: event.data.postJobId` on
 * `publishToAllPlatforms`, so a second send of an event triggers no second run.
 */
export async function materializeAndDispatchChunk(
  postJobIds: string[],
  deps: { send: (events: PublishEvent[]) => Promise<unknown>; sleep?: Sleep },
): Promise<ChunkDispatchResult> {
  const { publishEvents, noConnections, notFound, errorIds } = await materializeClaimedJobs(
    postJobIds,
    deps.sleep,
  );

  let dispatched = 0;
  let dispatchErrors = 0;
  const subBatches = splitEventsBySize(publishEvents);
  for (const [subBatchIndex, subBatch] of subBatches.entries()) {
    try {
      await deps.send(subBatch);
      dispatched += subBatch.length;
    } catch (error) {
      // The sub-batch's jobs stay in_progress; the stuck-job reconciler finalizes them.
      logger.error("[Inngest] Scheduled dispatch failed", {
        subBatchIndex,
        events: subBatch.length,
        error,
      });
      dispatchErrors += subBatch.length;
    }
  }

  return { dispatched, dispatchErrors, noConnections, notFound, errorIds };
}

/**
 * Finalize jobs stuck in `in_progress` past {@link STUCK_IN_PROGRESS_MS}.
 *
 * A materialize/dispatch crash can leave claimed scheduled jobs (or a mid-
 * publish run) with status still `in_progress` forever — the next due-scan
 * only re-queries `scheduled`. For each stale row:
 *  - If there are result rows: recompute terminal status from them (and mark
 *    any still-`pending` results failed so recompute can complete).
 *  - If there are no results: mark the job `failed`.
 *
 * A still-`pending` result a platform step CLAIMED (`claimRunId` set; the claim
 * only lives inside one step, <= 300 s) lost its run mid-call and may already be
 * live, so it is marked PUBLISH_UNCONFIRMED ("check the platform before you
 * retry"). Only an unclaimed one, which provably never reached the platform, is
 * PUBLISH_STALLED ("you can retry"). 2026-11-01 scale audit (jobs H6).
 *
 * Conditional `updateMany` keeps concurrent reconcilers safe.
 */
export async function reconcileStuckInProgressJobs(
  now: Date,
  take: number = STUCK_RECONCILE_BATCH,
  maxAgeMs: number = STUCK_IN_PROGRESS_MS,
): Promise<{ reconciled: number }> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const candidates = await prisma.postJob.findMany({
    where: { status: "in_progress", updatedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take,
  });

  let reconciled = 0;
  for (const job of candidates) {
    const results = await prisma.postJobResult.findMany({
      where: { postJobId: job.id },
      select: { id: true, status: true, claimRunId: true },
    });

    if (results.length === 0) {
      const { count } = await prisma.postJob.updateMany({
        where: { id: job.id, status: "in_progress" },
        data: { status: "failed" },
      });
      if (count === 1) reconciled += 1;
      continue;
    }

    const pending = results.filter((r) => r.status === "pending");
    const claimedIds = pending.filter((r) => r.claimRunId != null).map((r) => r.id);
    const unclaimedIds = pending.filter((r) => r.claimRunId == null).map((r) => r.id);
    // The claim state is re-asserted in each write, so a result claimed (or
    // re-queued) since the read above is left to its run.
    if (claimedIds.length > 0) {
      await prisma.postJobResult.updateMany({
        where: { id: { in: claimedIds }, status: "pending", claimRunId: { not: null } },
        data: {
          status: "failed",
          errorCode: PUBLISH_UNCONFIRMED_CODE,
          errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
        },
      });
    }
    if (unclaimedIds.length > 0) {
      await prisma.postJobResult.updateMany({
        where: { id: { in: unclaimedIds }, status: "pending", claimRunId: null },
        data: {
          status: "failed",
          errorCode: "PUBLISH_STALLED",
          errorMessage:
            "Publish did not complete (stalled). You can retry this platform.",
        },
      });
    }

    const finalResults = await prisma.postJobResult.findMany({
      where: { postJobId: job.id },
      select: { status: true },
    });
    const finalStatus = recomputePostJobStatus(finalResults);
    const { count } = await prisma.postJob.updateMany({
      where: { id: job.id, status: "in_progress" },
      data: { status: finalStatus },
    });
    if (count === 1) reconciled += 1;
  }

  return { reconciled };
}
