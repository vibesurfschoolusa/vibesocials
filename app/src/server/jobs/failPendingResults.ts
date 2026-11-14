import type { Platform, PostJobStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";

/** Why a job's still-pending results are being failed. */
export interface PendingResultFailure {
  /** Internal classification stored on each result (never shown to users). */
  errorCode: string;
  /** Sanitized, user-facing reason stored on each result. */
  errorMessage: string;
}

/**
 * The publish event couldn't be handed to Inngest AFTER the job was committed
 * `in_progress` (2026-11-01 audit). The routes return the same code + message
 * in their 503 body.
 */
export const DISPATCH_FAILURE = {
  errorCode: "DISPATCH_FAILED",
  errorMessage: "Couldn't start publishing. Please try again.",
} as const satisfies PendingResultFailure;

/**
 * What a result is failed with when its connection was removed (Disconnect /
 * Switch account) after the job was dispatched (2026-11-02 scale audit,
 * correctness L1). The same code and copy `publishToPlatform` writes when the
 * connection vanishes between the setup step and the publish.
 */
export const CONNECTION_GONE_FAILURE = {
  errorCode: "CONNECTION_GONE",
  errorMessage: "This platform connection was removed. Reconnect and retry.",
} as const satisfies PendingResultFailure;

/**
 * What a result that a platform step CLAIMED but never finished is failed with
 * (2026-11-01 scale audit, jobs H6). The claim means the step started and the
 * platform call may have gone through, so "failed, please retry" would invite a
 * second post; the user is told to check the platform first instead.
 */
export const PUBLISH_UNCONFIRMED = {
  errorCode: PUBLISH_UNCONFIRMED_CODE,
  errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
} as const satisfies PendingResultFailure;

/**
 * Prisma `maxWait` of the recompute transaction: how long to wait for a pooled
 * connection to open it. Prisma's default is 2 s, which a busy 5-connection
 * serverless pool can exceed during a burst of finalizers (final review F7).
 */
export const RECOMPUTE_TX_MAX_WAIT_MS = 5_000;

/**
 * Prisma `timeout` of the recompute transaction, counted from when it opened.
 * The work is one row lock, one read and one write, but the lock can queue behind
 * another finalizer of the same job, so Prisma's 5 s default is too tight; 10 s
 * still ends well inside the step's budget (final review F7).
 */
export const RECOMPUTE_TX_TIMEOUT_MS = 10_000;

/**
 * Recompute a job's status over ALL its results and store it, serialized per job
 * (2026-11-01 scale audit, jobs H6). Every run-side finalizer goes through here:
 * the `finalize-job` / `finalize-retry` steps and {@link failPendingPostJobResults}.
 * The exceptions are the 2 h stuck-job reconciler and the 6 h stale sweep: they
 * write the job status with conditional `updateMany` statements, without this lock.
 *
 * Several runs of one job can now finalize at once (the retry function no longer
 * holds a `postJobId` concurrency key). A bare read-then-write would let a
 * finalizer holding a STALE read write `in_progress` AFTER another wrote
 * `completed`, and nothing would move the job again until the 2 h reconciler.
 * The first statement of the transaction therefore takes the PostJob row lock
 * (`SELECT ... FOR UPDATE`): a second finalizer waits for the first to commit and
 * then reads the results afresh, so the last write always reflects every result
 * written before it. Result writes (a platform step's `finalizeClaimedResult`)
 * do not take this lock, only the PostJob row they bump for the heartbeat.
 *
 * A database failure throws, which retries the finalize step (it is idempotent).
 */
export async function recomputeAndStorePostJobStatus(
  postJobId: string,
): Promise<{ status: PostJobStatus; successCount: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "PostJob" WHERE "id" = ${postJobId} FOR UPDATE`;

      const results = await tx.postJobResult.findMany({
        where: { postJobId },
        select: { status: true },
      });
      const status = recomputePostJobStatus(results);

      await tx.postJob.update({
        where: { id: postJobId },
        data: { status },
      });

      if (status === "completed" || status === "failed") {
        await stampPostMediaLastUsed(tx, postJobId, new Date());
      }

      return {
        status,
        successCount: results.filter((result) => result.status === "success").length,
      };
    },
    { maxWait: RECOMPUTE_TX_MAX_WAIT_MS, timeout: RECOMPUTE_TX_TIMEOUT_MS },
  );
}

/**
 * F1 H2: a post that reached a final state used its media just now. Retention
 * counts a media item's age from `lastUsedAt`, which the create path stamps when
 * the post is made, so a post scheduled weeks ahead, an old draft or a repeat
 * series finished with media the sweep already took for 30 days unused. Stamping
 * it here, where every finalizer passes, makes the age count from the last use.
 * A post with several photos stamps each of them (PostJobMedia); a post without
 * a file stamps nothing; a swept item stays swept.
 */
export async function stampPostMediaLastUsed(
  db: Pick<Prisma.TransactionClient, "postJob" | "mediaItem">,
  postJobId: string,
  now: Date,
): Promise<void> {
  const job = await db.postJob.findUnique({
    where: { id: postJobId },
    select: { mediaItemId: true, media: { select: { mediaItemId: true } } },
  });
  if (!job) return;
  const ids = new Set<string>(job.media.map((row) => row.mediaItemId));
  if (job.mediaItemId) ids.add(job.mediaItemId);
  if (ids.size === 0) return;
  await db.mediaItem.updateMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    data: { lastUsedAt: now },
  });
}

/**
 * End a job with a conditional write and stamp its media's last use (review
 * round 2, item 6). Every path that gives a job its final status outside the
 * locked recompute goes through here: cancel, the bare no-connection fail of a
 * deferred dispatch, the stuck-job reconciler and the 6 h stale sweep. So a new
 * final path that uses it cannot forget the stamp (F1 H2). `where` carries the
 * caller's own guard (status, age); the stamp runs only when the write matched,
 * so a job another writer moved first is left as it is. Returns the count.
 */
export async function finishPostJob(
  db: Pick<Prisma.TransactionClient, "postJob" | "mediaItem">,
  args: {
    where: Prisma.PostJobWhereInput & { id: string };
    data: Prisma.PostJobUpdateManyMutationInput;
    now?: Date;
  },
): Promise<number> {
  const { count } = await db.postJob.updateMany({ where: args.where, data: args.data });
  if (count === 1) await stampPostMediaLastUsed(db, args.where.id, args.now ?? new Date());
  return count;
}

/**
 * Fail every still-`pending` PostJobResult of a job, then recompute the job's
 * status over ALL its results with the same rule the publish pipeline uses
 * (`recomputePostJobStatus`, through {@link recomputeAndStorePostJobStatus}), so a
 * job whose run never started — or was cut short — can't sit `in_progress`
 * forever. Results that already finished are
 * untouched: a platform that went live stays live (the job then reads
 * `completed`, and the failed rows are retryable).
 *
 * Two kinds of pending result (2026-11-01 scale audit, jobs H6). One a platform
 * step has CLAIMED (`claimRunId` set) may be mid-call to the platform — or
 * already live — so it is failed with {@link PUBLISH_UNCONFIRMED}, never with
 * `failure`. One nobody claimed provably never reached the platform and gets
 * `failure`'s code and message. The claimed rows are written first, so a row
 * claimed between the two writes is simply left to its run.
 *
 * Shared by every route that dispatches `post/publish.requested` (on an
 * `inngest.send` failure) and the publish functions' Inngest `onFailure`
 * handlers — hence the parameterized failure — and by retryPlatforms'
 * fail-media-unavailable step in inngest-functions.ts.
 *
 * `options.platforms` (Task 4 fix round 1, ruling R8b) narrows the write to
 * those platforms' pending results — a dead RETRY run may only fail what it
 * re-queued, since another run of the same job can still own the rest. The
 * status recompute always covers ALL results. Omitted = every pending result
 * (unchanged for existing callers).
 */
export async function failPendingPostJobResults(
  postJobId: string,
  failure: PendingResultFailure,
  options: { platforms?: Platform[] } = {},
): Promise<{ failedCount: number; unconfirmedCount: number; status: PostJobStatus }> {
  const { platforms } = options;
  const scope = {
    postJobId,
    status: "pending" as const,
    ...(platforms ? { platform: { in: platforms } } : {}),
  };

  const { count: unconfirmedCount } = await prisma.postJobResult.updateMany({
    where: { ...scope, claimRunId: { not: null } },
    data: {
      status: "failed",
      errorCode: PUBLISH_UNCONFIRMED.errorCode,
      errorMessage: PUBLISH_UNCONFIRMED.errorMessage,
    },
  });
  const { count: failedCount } = await prisma.postJobResult.updateMany({
    where: { ...scope, claimRunId: null },
    data: {
      status: "failed",
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    },
  });

  // The row writes above are NOT in the recompute's transaction, so the job lock
  // is never held while result rows are locked.
  const { status } = await recomputeAndStorePostJobStatus(postJobId);

  return { failedCount, unconfirmedCount, status };
}
