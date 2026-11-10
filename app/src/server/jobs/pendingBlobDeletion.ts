import { del } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BLOB_DELETE_TIMEOUT_MS } from "@/server/jobs/mediaBlob";

/**
 * The PendingBlobDeletion queue: stored files of deleted workspaces. A
 * workspace or account deletion writes the rows in the same transaction that
 * deletes the media rows, tries the files right after it commits, and leaves
 * whatever it could not finish here. The hourly mediaRetentionSweep drains it.
 */

/** Rows one drain run takes, oldest first. */
export const DRAIN_BATCH_SIZE = 200;
/** How long one drain run may spend, so its step stays well inside Inngest's limit. */
export const DRAIN_BUDGET_MS = 60_000;

/**
 * One Blob `del()` (a key or an array of keys) aborted after `timeoutMs`,
 * at most BLOB_DELETE_TIMEOUT_MS. A reason-less abort, as in mediaBlob.ts:
 * the SDK fails fast on an AbortError but retries a TimeoutError.
 */
export async function deleteBlobsWithTimeout(keys: string | string[], timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, BLOB_DELETE_TIMEOUT_MS));
  try {
    await del(keys, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface DrainResult {
  deleted: number;
  /** In use by a live media item again: the row is dropped, the file kept. */
  kept: number;
  /** Failed, or not reached within the budget: still queued. */
  left: number;
}

/**
 * Works through up to DRAIN_BATCH_SIZE queued files for at most
 * DRAIN_BUDGET_MS. One file at a time, so one bad URL cannot hold up the
 * others: it only collects attempts.
 */
export async function drainPendingBlobDeletions(
  opts: { now?: () => number } = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + DRAIN_BUDGET_MS;
  const rows = await prisma.pendingBlobDeletion.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: DRAIN_BATCH_SIZE,
    select: { id: true, url: true },
  });

  const result: DrainResult = { deleted: 0, kept: 0, left: 0 };
  for (let index = 0; index < rows.length; index += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      result.left += rows.length - index;
      break;
    }
    const row = rows[index];
    const key = guardBlobKey(row.url);
    const spellings = key === row.url ? [key] : [key, row.url];

    // Someone may have registered the same file in another workspace since
    // it was queued (POST /api/media accepts any allowed blob URL).
    const inUse = await prisma.mediaItem.count({
      where: { storageLocation: { in: spellings }, deletedAt: null },
    });
    if (inUse > 0) {
      await prisma.pendingBlobDeletion.delete({ where: { id: row.id } });
      result.kept += 1;
      continue;
    }

    try {
      await deleteBlobsWithTimeout(key, remaining);
    } catch (error) {
      logger.warn("[pendingBlobDeletion] Delete failed, kept queued", { id: row.id, error });
      await prisma.pendingBlobDeletion.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      result.left += 1;
      continue;
    }
    await prisma.pendingBlobDeletion.delete({ where: { id: row.id } });
    result.deleted += 1;
  }

  logger.info("[pendingBlobDeletion] Drain complete", { ...result });
  return result;
}
