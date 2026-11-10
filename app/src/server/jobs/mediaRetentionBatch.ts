import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { deleteBlobUnlessShared } from "@/server/jobs/mediaBlob";
import {
  RETENTION_DAYS,
  TERMINAL_POST_JOB_STATUSES,
  isMediaSweepEligible,
} from "@/server/jobs/mediaRetention";

/**
 * 2026-11-01 scale audit (jobs, media retention): the batched retention sweep.
 *
 * The daily sweep took 500 candidates in ONE step while about 10,000 media items
 * a day become eligible at the reference load, so Blob storage grew without
 * bound. It now runs hourly (`mediaRetentionSweep`, inngest-functions.ts) and
 * each run loops up to {@link RETENTION_MAX_BATCHES_PER_RUN} `sweep-batch-<i>`
 * steps of {@link RETENTION_BATCH_SIZE} candidates: 3,000 an hour, about 72,000 a
 * day, against about 10,000 a day of inflow.
 */

/** Candidates per batch step. */
export const RETENTION_BATCH_SIZE = 200;

/**
 * Batch steps per run. 200 x 15 x 24 = 72,000 items a day, over seven times the
 * reference inflow; a run that finds fewer candidates stops at the first batch
 * that comes back short.
 */
export const RETENTION_MAX_BATCHES_PER_RUN = 15;

/**
 * In-step time budget of one batch. Each batch is its own step (its own
 * invocation, capped at 300 s on Vercel); after the budget the batch stops
 * between items and hands the cursor back. The budget plus at most one more item
 * transaction (15 s) stays well under the 300 s cap.
 */
export const RETENTION_BATCH_BUDGET_MS = 150_000;

/**
 * Where the next batch resumes: the (createdAt, id) of the last candidate this
 * run handled. `createdAt` is an ISO string so the cursor survives Inngest's
 * JSON memoization of the step output.
 *
 * 07a: `pass: "photos"` is the second pass, over photos used only as a post's
 * second or later photo (see sweepExpiredMediaBatch). Its first batch starts
 * with `createdAt` and `id` null. A cursor without `pass` is the first pass, so
 * a run saved before 07a resumes where it was.
 */
export type RetentionCursor =
  | { createdAt: string; id: string; pass?: undefined }
  | { pass: "photos"; createdAt: string | null; id: string | null };

export interface RetentionBatchResult {
  /** Candidates the query returned (not all are processed when the budget runs out). */
  candidates: number;
  swept: number;
  skipped: number;
  errors: number;
  /** The last candidate handled (swept, skipped or errored), else the `after` it was given. */
  next: RetentionCursor | null;
  /** True when no further candidate follows `next`: the run can stop. */
  exhausted: boolean;
}

/**
 * One keyset-paged batch of the retention sweep.
 *
 * Candidates are ordered by `(createdAt, id)` and bounded by
 * `createdAt < cutoff`: every eligible row satisfies that, because `lastUsedAt`
 * is never older than `createdAt` (`@@index([deletedAt, createdAt, id])` serves
 * the filter and the order). The cursor moves past EVERY row handled, so a row
 * that was skipped (no longer eligible) or errored (blob store down) is not
 * selected again within the run; the next run starts from the beginning and
 * retries it.
 *
 * The coarse candidate filter below is the daily sweep's, unchanged (let the DB
 * narrow the set): not already swept, posted at least once, no non-terminal
 * referencing job, and stale by age (`lastUsedAt` when stamped, else
 * `createdAt`). The authoritative rule and the race-closing re-check run per
 * item inside the transaction, also unchanged.
 *
 * 07a: a post with several photos refers to its second and later photos only
 * through PostJobMedia. Two passes keep every relation filter at the top level
 * (Postgres runs a top-level `some` / `none` as a semi- / anti-join on the
 * relation's index, but a relation filter inside an OR as a subplan over the
 * whole table):
 *  - the first pass is today's query plus one top-level `none`: no unfinished
 *    post uses the item through PostJobMedia;
 *  - the photo pass (`after.pass === "photos"`) takes items with a PostJobMedia
 *    row, no PostJob.mediaItemId reference at all (the first pass covers those)
 *    and no unfinished post through PostJobMedia, by the same age rule.
 * When the first pass runs out, one existence query on PostJobMedia decides
 * whether the photo pass runs: with no rows the batch reports `exhausted`, so
 * the sweep's queries are today's plus that one check. Both passes run in the
 * run's `sweep-batch-<i>` steps and share their limits.
 */
export async function sweepExpiredMediaBatch(opts: {
  after: RetentionCursor | null;
  now?: Date;
  take?: number;
  budgetMs?: number;
  clock?: () => number;
}): Promise<RetentionBatchResult> {
  const { after } = opts;
  const now = opts.now ?? new Date();
  const take = opts.take ?? RETENTION_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? RETENTION_BATCH_BUDGET_MS;
  const clock = opts.clock ?? Date.now;
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const photoPass = after?.pass === "photos";
  const nonTerminal = { status: { notIn: [...TERMINAL_POST_JOB_STATUSES] } };
  const where: Prisma.MediaItemWhereInput = photoPass
    ? {
        deletedAt: null,
        createdAt: { lt: cutoff },
        postJobMedia: { some: {}, none: { postJob: nonTerminal } },
        postJobs: { none: {} },
        AND: [
          {
            OR: [
              { lastUsedAt: { lt: cutoff } },
              { lastUsedAt: null, createdAt: { lt: cutoff } },
            ],
          },
        ],
      }
    : {
        deletedAt: null,
        createdAt: { lt: cutoff },
        postJobs: {
          some: {},
          none: nonTerminal,
        },
        // 07a: not one of several photos of an unfinished post.
        postJobMedia: { none: { postJob: nonTerminal } },
        AND: [
          {
            OR: [
              { lastUsedAt: { lt: cutoff } },
              { lastUsedAt: null, createdAt: { lt: cutoff } },
            ],
          },
        ],
      };
  if (after && after.createdAt !== null && after.id !== null) {
    const cursorAt = new Date(after.createdAt);
    where.OR = [{ createdAt: { gt: cursorAt } }, { createdAt: cursorAt, id: { gt: after.id } }];
  }

  const candidates = await prisma.mediaItem.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true, createdAt: true },
  });

  const startedAt = clock();
  let swept = 0;
  let skipped = 0;
  let errors = 0;
  let next: RetentionCursor | null = after;
  let stoppedEarly = false;

  for (const [index, candidate] of candidates.entries()) {
    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          // Lock the MediaItem row before re-checking, so a concurrent reuse
          // (which takes the same FOR UPDATE lock in createPostJobForExistingMedia)
          // serializes with us: after this returns we see any reuse that
          // committed first, and a reuse that arrives after waits until we
          // commit the soft-delete. Closes the check-then-act reuse race.
          await tx.$executeRaw`SELECT id FROM "MediaItem" WHERE id = ${candidate.id} FOR UPDATE`;

          const media = await tx.mediaItem.findUnique({
            where: { id: candidate.id },
            select: {
              storageLocation: true,
              deletedAt: true,
              lastUsedAt: true,
              createdAt: true,
              _count: { select: { postJobs: true, postJobMedia: true } },
            },
          });
          if (!media) return "skipped";

          // Fresh, in-transaction re-check of the race-sensitive predicate.
          const nonTerminalJobs = await tx.postJob.count({
            where: {
              mediaItemId: candidate.id,
              status: { notIn: [...TERMINAL_POST_JOB_STATUSES] },
            },
          });
          // 07a: the same for a photo used through PostJobMedia. A separate
          // count, so each stays an index lookup by mediaItemId.
          const nonTerminalPhotoUses = await tx.postJobMedia.count({
            where: { mediaItemId: candidate.id, postJob: nonTerminal },
          });

          const eligible = isMediaSweepEligible({
            deletedAt: media.deletedAt,
            hasNonTerminalJob: nonTerminalJobs > 0 || nonTerminalPhotoUses > 0,
            hasAnyJob: media._count.postJobs > 0 || media._count.postJobMedia > 0,
            lastUsedAt: media.lastUsedAt,
            createdAt: media.createdAt,
            now,
            retentionDays: RETENTION_DAYS,
          });
          if (!eligible) return "skipped";

          // Mark the row first, then remove the blob: if `del` throws the
          // whole transaction rolls back, so we never record a delete we did
          // not actually perform. (`del` is idempotent for a missing blob.)
          // The blob is removed only when no OTHER live MediaItem (any
          // workspace) references the same URL — `POST /api/media` lets two
          // rows point at one file, and sweeping one must not destroy the
          // other's media (2026-11-01 audit, Task 8).
          await tx.mediaItem.update({
            where: { id: candidate.id },
            data: { deletedAt: now },
          });
          await deleteBlobUnlessShared(tx, {
            id: candidate.id,
            storageLocation: media.storageLocation,
          });
          return "swept";
        },
        { timeout: 15000 },
      );

      if (outcome === "swept") swept += 1;
      else skipped += 1;
    } catch (error) {
      errors += 1;
      logger.error("[Inngest] Failed to sweep media item", {
        mediaItemId: candidate.id,
        error,
      });
    }

    // Past this row whatever happened to it: a skipped or errored row must not
    // be selected again within the run.
    const handled = { createdAt: candidate.createdAt.toISOString(), id: candidate.id };
    next = photoPass ? { pass: "photos", ...handled } : handled;

    // Out of budget: stop BETWEEN items and hand the cursor back. The first item
    // always runs, so a batch makes progress however small the budget.
    if (index < candidates.length - 1 && clock() - startedAt >= budgetMs) {
      stoppedEarly = true;
      break;
    }
  }

  // A short page is the end of the list. A full page may be followed by more,
  // and a batch cut short by the budget certainly is.
  let exhausted = !stoppedEarly && candidates.length < take;
  // 07a: the end of the first pass starts the photo pass, when there can be any.
  if (exhausted && !photoPass) {
    const anyPhotoRow = await prisma.postJobMedia.findFirst({ select: { id: true } });
    if (anyPhotoRow) {
      exhausted = false;
      next = { pass: "photos", createdAt: null, id: null };
    }
  }

  const result: RetentionBatchResult = {
    candidates: candidates.length,
    swept,
    skipped,
    errors,
    next,
    exhausted,
  };
  console.log("[Inngest] Media retention batch complete", result);
  return result;
}
