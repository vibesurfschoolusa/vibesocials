import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { RETENTION_DAYS } from "@/server/jobs/mediaRetention";

/**
 * A video cover's stored image (V1 fix round 1). It has no MediaItem row: it
 * belongs to the post (PostJob.coverImageUrl), and the posts of one series
 * share it. A file no post refers to any more goes to the PendingBlobDeletion
 * queue, which the hourly mediaRetentionSweep drains, so a failed delete never
 * fails the user's action and is tried again.
 */

/** Posts one sweep run clears; the hourly run catches up on the rest. */
export const COVER_SWEEP_BATCH_SIZE = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type CoverDb = Pick<typeof prisma, "postJob" | "pendingBlobDeletion">;

async function queueIfUnused(db: CoverDb, url: string): Promise<boolean> {
  const stillUsed = await db.postJob.count({ where: { coverImageUrl: url } });
  if (stillUsed > 0) return false;
  await db.pendingBlobDeletion.create({ data: { url: guardBlobKey(url) } });
  return true;
}

/**
 * Queue a cover's file for deletion when no post refers to it any more (after
 * a post was deleted). Never throws: the post is already gone.
 */
export async function queueCoverBlobIfUnused(url: string): Promise<boolean> {
  try {
    return await queueIfUnused(prisma, url);
  } catch (error) {
    logger.warn("[coverBlobs] A cover's file could not be queued for deletion", { error });
    return false;
  }
}

/**
 * Part of the hourly media retention sweep: a completed or cancelled post last
 * changed more than RETENTION_DAYS ago lets go of its cover image, and the file
 * is queued once no post uses it. A failed post keeps its cover: it can still
 * be retried, and its media may be in use much later. The column is cleared
 * with a raw UPDATE (so `updatedAt` does not move) that checks status and age
 * again, so a post retried or edited after the read keeps its cover. A
 * scheduled, draft or recent post keeps it too. Never throws.
 */
const SWEPT_COVER_STATUSES = ["completed", "cancelled"] as const;

export async function sweepOldCovers(
  opts: { now?: () => number } = {},
): Promise<{ cleared: number; queued: number }> {
  const now = opts.now ?? Date.now;
  let cleared = 0;
  let queued = 0;
  try {
    const cutoff = new Date(now() - RETENTION_DAYS * MS_PER_DAY);
    const rows = await prisma.postJob.findMany({
      where: {
        coverImageUrl: { not: null },
        status: { in: [...SWEPT_COVER_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, coverImageUrl: true },
      orderBy: { id: "asc" },
      take: COVER_SWEEP_BATCH_SIZE,
    });
    for (const row of rows) {
      const url = row.coverImageUrl;
      if (!url) continue;
      try {
        const done = await prisma.$transaction(async (tx) => {
          // DateTime columns hold UTC wall-clock time and Prisma binds a Date as
          // timestamptz, so the cutoff is converted as in scheduledScanner.ts.
          const changed = await tx.$executeRaw`UPDATE "PostJob" SET "coverImageUrl" = NULL WHERE "id" = ${row.id} AND "coverImageUrl" = ${url} AND "updatedAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC') AND "status"::text IN ('completed', 'cancelled')`;
          if (changed === 0) return { cleared: 0, queued: 0 };
          return { cleared: 1, queued: (await queueIfUnused(tx, url)) ? 1 : 0 };
        });
        cleared += done.cleared;
        queued += done.queued;
      } catch (error) {
        logger.warn("[coverBlobs] An old post's cover was left for the next run", { postJobId: row.id, error });
      }
    }
  } catch (error) {
    logger.warn("[coverBlobs] The cover sweep did not run", { error });
  }
  if (cleared > 0) logger.info("[coverBlobs] Old covers let go", { cleared, queued });
  return { cleared, queued };
}
