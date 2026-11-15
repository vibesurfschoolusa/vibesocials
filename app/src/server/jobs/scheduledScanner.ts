import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { finishPostJob, stampPostMediaLastUsed } from "@/server/jobs/failPendingResults";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";
import {
  buildPublishEvent,
  prepareDeferredPostJobDispatch,
  type PublishEvent,
} from "@/server/jobs/posting";
import { notifyNotSentAtScan, type ScanNotice } from "@/server/notifications/scannerNotice";
import { withdrawSend } from "@/server/usage/usageLog";

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
 * full tick is 2 + 20 steps (the owners of posts it could not send are told
 * from those steps, R8-security L1).
 */
export const DUE_SCAN_BATCH = 1000;

/**
 * Claimed jobs materialized and dispatched per `materialize-dispatch-batch-<i>`
 * step. 2026-11-01 scale audit (jobs H6): this bounds the DB work and wall-clock
 * time of one step (50 jobs, a few queries each, plus the inline retries of
 * {@link MATERIALIZE_RETRY_DELAYS_MS}, well inside the route's 300 s) and keeps a
 * full tick of {@link DUE_SCAN_BATCH} at 2 + 20 chunk steps against Inngest's 1,000 steps per run
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
 * F1 H3: how long a claimed scheduled post must sit with no results before the
 * reconciler takes it as unsent and puts it back. Longer than a route's 300 s,
 * so a Post now whose materialize is still running is never touched; shorter
 * than the scanner's 10-minute tick, so the next tick sends it again. The
 * scanner's own chunk steps cannot be mid-run then: `singleton: skip` runs the
 * reconciler only when no earlier scan is still going.
 */
export const REQUEUE_QUIET_MS = 6 * 60 * 1000;

/**
 * F1 H3: a scheduled post that still could not be sent this long after the
 * scanner first picked it up fails, with NOT_SENT_MESSAGE in Activity,
 * instead of being put back again; Send again sends it. The clock is
 * `GREATEST(pickedUpAt, scheduledFor)`: the pickup, or the slot when the post was
 * rescheduled or sent with Post now since (or claimed before `pickedUpAt` existed).
 */
export const SEND_GIVE_UP_MS = 2 * 60 * 60 * 1000;

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
 * F1 H3 follow-up: `pickedUpAt` records the first pickup for the post's current
 * slot. A post the reconciler put back keeps it when claimed again (its
 * scheduledFor did not move); one whose slot moved past it gets a new one.
 *
 * Returns the claimed ids, oldest `scheduledFor` first. The scanner runs every
 * 10 minutes (to stay inside Inngest's free plan), and ≤10-minute latency is
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
          "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'),
          "pickedUpAt" = CASE WHEN "pickedUpAt" IS NOT NULL AND "pickedUpAt" >= "scheduledFor" THEN "pickedUpAt" ELSE (${now}::timestamptz AT TIME ZONE 'UTC') END
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
  /**
   * Jobs marked `failed` with nothing sent (no eligible connection, or refused
   * by the day's limits), with whom to tell, their workspace and why.
   */
  noConnections: ScanNotice[];
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
 * straddles a deploy), duplicates no rows. The stable event id then dedupes the
 * second publish only for events sent by this code (Review Focus 3): events the
 * pre-phase-2 scanner sent carry no id, so a scan that straddles that deploy can
 * re-send them (the release runbook in docs/STAGING_SETUP.md pauses the scanner).
 *
 * The events can be large and are NOT step output: only
 * {@link materializeAndDispatchChunk} calls this, and it returns counts and ids.
 *
 * @param sleep injectable so tests do not wait out the retry delays.
 */
export async function materializeClaimedJobs(
  postJobIds: string[],
  sleep: Sleep = defaultSleep,
  /**
   * Second review of K2: the posts whose day's send this call wrote, with the
   * moment (its day): a pair's feed reserves its Story's. A post that then
   * keeps throwing, or whose hand-over fails, has its send taken back.
   */
  sendsWritten: Map<string, Date> = new Map(),
): Promise<MaterializedBatch> {
  const batch: MaterializedBatch = {
    publishEvents: [],
    noConnections: [],
    notFound: [],
    errorIds: [],
  };

  /** Takes back a send this call wrote for `postJobId`, and only such a send. */
  const takeBack = async (postJobId: string) => {
    const day = sendsWritten.get(postJobId);
    if (!day) return;
    sendsWritten.delete(postJobId);
    await withdrawSend({ postJobIds: [postJobId], day });
  };

  for (const postJobId of postJobIds) {
    try {
      await withMaterializeRetries(
        async () => {
          // R6-security M2: a scheduled post meets the service's daily cap as
          // it falls due, so posts scheduled far ahead cannot fill a day.
          const prep = await prepareDeferredPostJobDispatch(postJobId, { serviceCapAt: new Date() });
          if (prep.ok) {
            for (const id of prep.sendsWritten?.postJobIds ?? []) sendsWritten.set(id, prep.sendsWritten!.day);
            // The scanner is not "Post now": `immediate: false` keeps the run at
            // priority 0 behind user-triggered publishes.
            batch.publishEvents.push(buildPublishEvent(prep.event, { immediate: false }));
          } else if (prep.reason === "BLOCKED") {
            // R7-publishing L1: paused, or its plan ended. Its results say so;
            // nothing was recorded, and like the publish run's own paused
            // path no notice goes out, so a paused week does not flood the owner.
            return;
          } else if (prep.reason === "NO_CONNECTIONS" || prep.reason === "LIMIT_REACHED") {
            // Nothing to send: a send this call reserved for it (its feed's) goes.
            await takeBack(postJobId);
            // The job is already marked failed, its results saying why; look up whom to tell.
            // A pair refused at send is told about once, as its feed (the
            // notice id is the post's, so a re-run sends it once too).
            const noticeFor = prep.reason === "LIMIT_REACHED" ? prep.noticeFor : postJobId;
            if (batch.noConnections.some((notice) => notice.postJobId === noticeFor)) return;
            const owner = await prisma.postJob.findUnique({
              where: { id: noticeFor },
              select: { userId: true, workspaceId: true },
            });
            if (owner) {
              batch.noConnections.push({
                postJobId: noticeFor,
                userId: owner.userId,
                workspaceId: owner.workspaceId,
                reason: prep.reason,
              });
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
      // Not handed to publishing: a send reserved for it in this call goes.
      await takeBack(postJobId);
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
  /** The posts it did not send; their owners were told from this step. */
  noConnections: ScanNotice[];
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
 * `publishToAllPlatforms`, so a second send of an event this code sent triggers no
 * second run. That dedupe covers only events sent by this code: events the
 * pre-phase-2 scanner sent carry no id (hence the scanner pause in the release
 * runbook, docs/STAGING_SETUP.md).
 *
 * R8-security L1: the owners of the posts it did not send are told from this
 * step (`notifyNotSentAtScan`, which never throws), not through an event and
 * another function's run, so a post that never runs costs no execution. At
 * most one per workspace, recipient and reason a UTC day; a re-run of the step
 * is deduplicated by the same key.
 */
export async function materializeAndDispatchChunk(
  postJobIds: string[],
  deps: { send: (events: PublishEvent[]) => Promise<unknown>; sleep?: Sleep },
): Promise<ChunkDispatchResult> {
  const sendsWritten = new Map<string, Date>();
  const { publishEvents, noConnections, notFound, errorIds } = await materializeClaimedJobs(
    postJobIds,
    deps.sleep,
    sendsWritten,
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
      // Second review of K2: these posts were not handed to publishing, so the
      // sends this attempt wrote for them go (one written earlier that day stays).
      const taken = subBatch.map((event) => event.data.postJobId).filter((id) => sendsWritten.has(id));
      if (taken.length > 0) await withdrawSend({ postJobIds: taken, day: sendsWritten.get(taken[0])! });
    }
  }

  // One per workspace, recipient and reason in this chunk; the daily key does the rest.
  const told = new Set<string>();
  for (const notice of noConnections) {
    const key = `${notice.workspaceId}:${notice.userId}:${notice.reason}`;
    if (told.has(key)) continue;
    told.add(key);
    await notifyNotSentAtScan(notice);
  }

  return { dispatched, dispatchErrors, noConnections, notFound, errorIds };

}

/** The `notification.requested` the reconciler sends for a job it closed. */
export type ClosedJobNotification = {
  id: string;
  name: "notification.requested";
  data: { userId: string; postJobId: string };
};

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
 * A job with a pending result that is waiting out a platform rate limit or quota
 * (`deferredUntil` still ahead, or ended less than `maxAgeMs` ago) is not a
 * candidate: its run is asleep, not dead, and the wait can be most of a day
 * (2026-11-01 scale audit, platform limits; Review Focus 2). Once the wait is
 * over the run claims the result again, which clears `deferredUntil`; if the run
 * died instead, the job becomes a candidate `maxAgeMs` after the wait ended.
 *
 * Conditional `updateMany` keeps concurrent reconcilers safe.
 *
 * F1 H3: first, a scheduled post that was claimed but never got its results
 * (its materialize threw, or its step died) is handled by
 * {@link requeueUnsentScheduledJobs}, so it is sent again instead of failed.
 *
 * R5-client-journey L3 review: a job with results that this closes is announced
 * through `deps.notify` with the `notification.requested` its dead run would have
 * sent, so its owner hears the outcome, and the other half of a Feed and Story
 * pair shares one email with it (postOutcomeEmail.ts). The event id carries the
 * stuck job's last heartbeat, so a resend for the same stuck run is deduped by
 * Inngest. A failed send is logged, not thrown: the jobs are closed either way.
 */
export async function reconcileStuckInProgressJobs(
  now: Date,
  take: number = STUCK_RECONCILE_BATCH,
  maxAgeMs: number = STUCK_IN_PROGRESS_MS,
  deps?: { notify?: (events: ClosedJobNotification[]) => Promise<unknown> },
): Promise<{ reconciled: number; requeued: number; gaveUp: number }> {
  const { requeued, gaveUp } = await requeueUnsentScheduledJobs(now, take);
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const candidates = await prisma.postJob.findMany({
    where: {
      status: "in_progress",
      updatedAt: { lt: cutoff },
      results: { none: { status: "pending", deferredUntil: { gte: cutoff } } },
    },
    select: { id: true, userId: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take,
  });

  let reconciled = 0;
  const closed: ClosedJobNotification[] = [];
  for (const job of candidates) {
    const results = await prisma.postJobResult.findMany({
      where: { postJobId: job.id },
      select: { id: true, status: true, claimRunId: true },
    });

    if (results.length === 0) {
      const count = await finishPostJob(prisma, {
        where: { id: job.id, status: "in_progress" },
        data: { status: "failed" },
        now,
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
    const write = { where: { id: job.id, status: "in_progress" as const }, data: { status: finalStatus } };
    // F1 H2: a final status stamps the media's last use (finishPostJob).
    const count =
      finalStatus === "in_progress"
        ? (await prisma.postJob.updateMany(write)).count
        : await finishPostJob(prisma, { ...write, now });
    if (count === 1) reconciled += 1;
    if (count === 1 && finalStatus !== "in_progress") {
      closed.push({
        id: `notify-reconciled-${job.id}-${new Date(job.updatedAt).getTime()}`,
        name: "notification.requested",
        data: { userId: job.userId, postJobId: job.id },
      });
    }
  }

  if (closed.length > 0 && deps?.notify) {
    try {
      await deps.notify(closed);
    } catch (error) {
      logger.error("[Inngest] Announcing reconciled jobs failed; their owners get no outcome email", {
        postJobIds: closed.map((event) => event.data.postJobId),
        error,
      });
    }
  }

  return { reconciled, requeued, gaveUp };
}

/**
 * F1 H3 (R1 publishing): a claimed scheduled post (`in_progress`, `scheduledFor`
 * set) with no results after {@link REQUEUE_QUIET_MS} was never sent: no
 * platform was tried. It goes back to `scheduled`, and the claim that follows
 * this reconcile in the same step takes it again. Once its first pickup is more
 * than {@link SEND_GIVE_UP_MS} ago it fails instead (Activity then shows
 * NOT_SENT_MESSAGE and its Send again button sends it), and its media
 * counts as used now (F1 H2), so Send again still finds it.
 *
 * Each is ONE statement: the inner SELECT locks the rows (`SKIP LOCKED`) and the
 * UPDATE re-checks `in_progress` with no results, so a post whose results were
 * made meanwhile is left to its run. It is never sent twice: the claim takes only
 * `scheduled` rows, the materialize creates results only when there are none,
 * and the publish event id is stable per job. A post with results is the
 * stuck-job pass's, unchanged. DateTime columns hold UTC wall-clock time, as in
 * {@link claimDueScheduledJobs}.
 */
async function requeueUnsentScheduledJobs(
  now: Date,
  take: number,
): Promise<{ requeued: number; gaveUp: number }> {
  const quietCutoff = new Date(now.getTime() - REQUEUE_QUIET_MS);
  const giveUpCutoff = new Date(now.getTime() - SEND_GIVE_UP_MS);

  const requeued = await prisma.$queryRaw<{ id: string }[]>`
    WITH requeued AS (
      UPDATE "PostJob"
      SET "status" = 'scheduled'::"PostJobStatus",
          "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT j."id" FROM "PostJob" j
        WHERE j."status" = 'in_progress'::"PostJobStatus"
          AND j."scheduledFor" IS NOT NULL
          AND GREATEST(j."pickedUpAt", j."scheduledFor") >= (${giveUpCutoff}::timestamptz AT TIME ZONE 'UTC')
          AND j."updatedAt" < (${quietCutoff}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (SELECT 1 FROM "PostJobResult" r WHERE r."postJobId" = j."id")
        ORDER BY j."scheduledFor" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      ) AND "status" = 'in_progress'::"PostJobStatus" AND NOT EXISTS (SELECT 1 FROM "PostJobResult" r WHERE r."postJobId" = "PostJob"."id")
      RETURNING "id"
    )
    SELECT "id" FROM requeued`;

  // `gaveUpAt` in the same UPDATE: the owner's notification is read from it
  // (notifyGivenUpPosts), so nothing after this commit can lose it.
  const gaveUp = await prisma.$queryRaw<{ id: string }[]>`
    WITH gave_up AS (
      UPDATE "PostJob"
      SET "status" = 'failed'::"PostJobStatus",
          "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'),
          "gaveUpAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT j."id" FROM "PostJob" j
        WHERE j."status" = 'in_progress'::"PostJobStatus"
          AND j."scheduledFor" IS NOT NULL
          AND GREATEST(j."pickedUpAt", j."scheduledFor") < (${giveUpCutoff}::timestamptz AT TIME ZONE 'UTC')
          AND j."updatedAt" < (${quietCutoff}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (SELECT 1 FROM "PostJobResult" r WHERE r."postJobId" = j."id")
        ORDER BY j."scheduledFor" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      ) AND "status" = 'in_progress'::"PostJobStatus" AND NOT EXISTS (SELECT 1 FROM "PostJobResult" r WHERE r."postJobId" = "PostJob"."id")
      RETURNING "id"
    )
    SELECT "id" FROM gave_up`;

  for (const { id } of gaveUp) {
    await stampPostMediaLastUsed(prisma, id, now);
  }
  if (requeued.length > 0 || gaveUp.length > 0) {
    logger.warn("[Inngest] Scheduled posts that were never sent", {
      requeued: requeued.map((row) => row.id),
      gaveUp: gaveUp.map((row) => row.id),
    });
  }
  return { requeued: requeued.length, gaveUp: gaveUp.length };
}

/** Posts told per scanner tick; the next tick takes the rest. */
export const NOTIFY_GIVEN_UP_BATCH = 100;

/**
 * F1 second review, items 3 and 4: tell the owner of each scheduled post the
 * reconciler gave up on, with the `notification.requested` event the
 * no-connections path sends. Read from the post row (`gaveUpAt`, written by the
 * give-up UPDATE itself, newer than `gaveUpNotifiedAt`), and marked told only
 * after the send, so a failed reconcile, a failed send or a crash between the
 * two loses nothing: the next tick finds the row again. The event id carries the
 * give-up moment, so a resend of one give-up is deduped by Inngest (24 h) and a
 * second give-up of the same post (after Send again) emails again. A post that
 * is no longer failed with no results (Send again took it) is not told. The
 * mark is a raw UPDATE, so `updatedAt` does not move. Throws on a failed send or
 * read; the caller logs it.
 */
export async function notifyGivenUpPosts(deps: {
  send: (events: Array<{ id: string; name: "notification.requested"; data: { userId: string; postJobId: string } }>) => Promise<unknown>;
  take?: number;
}): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string; userId: string; gaveUpAt: Date }[]>`
    SELECT "id", "userId", "gaveUpAt" FROM "PostJob"
    WHERE "status" = 'failed'::"PostJobStatus"
      AND "gaveUpAt" IS NOT NULL
      AND ("gaveUpNotifiedAt" IS NULL OR "gaveUpNotifiedAt" < "gaveUpAt")
      AND NOT EXISTS (SELECT 1 FROM "PostJobResult" r WHERE r."postJobId" = "PostJob"."id")
    ORDER BY "gaveUpAt" ASC
    LIMIT ${deps.take ?? NOTIFY_GIVEN_UP_BATCH}`;
  if (rows.length === 0) return 0;

  await deps.send(
    rows.map((row) => ({
      id: `notify-unsent-${row.id}-${new Date(row.gaveUpAt).getTime()}`,
      name: "notification.requested" as const,
      data: { userId: row.userId, postJobId: row.id },
    })),
  );
  await prisma.$executeRaw`
    UPDATE "PostJob" SET "gaveUpNotifiedAt" = "gaveUpAt"
    WHERE "id" IN (${Prisma.join(rows.map((row) => row.id))}) AND "gaveUpAt" IS NOT NULL`;
  return rows.length;
}
