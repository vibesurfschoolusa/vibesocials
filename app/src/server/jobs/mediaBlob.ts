import type { Prisma } from "@prisma/client";
import { del } from "@vercel/blob";

/** The slice of a Prisma transaction client {@link deleteBlobUnlessShared} needs. */
export type MediaBlobTx = Pick<Prisma.TransactionClient, "$executeRaw" | "mediaItem">;

export type BlobDeleteOutcome = "deleted" | "kept_shared";

/**
 * Removes a MediaItem's blob from storage ONLY when no other live
 * (non-purged, i.e. `deletedAt: null`) MediaItem — in ANY workspace — still
 * points at the same `storageLocation`.
 *
 * `POST /api/media` accepts any allowed blob URL, so two rows (even in
 * different workspaces) can reference one file; deleting the blob when either
 * is removed would silently destroy the other's media. "Purged" is defined
 * exactly as the retention sweep defines it: `deletedAt != null` means the row
 * was soft-deleted and its blob is already gone (or being removed).
 *
 * MUST run inside the transaction that already marked `media`'s own row as
 * deleted (`deletedAt` set) and holds its `FOR UPDATE` row lock: an
 * advisory lock keyed on the URL then serializes concurrent deletes of rows
 * that share it, so two simultaneous deletes can't each see the other as still
 * live and both skip (which would leak the blob). The loser of the lock sees
 * the winner's commit and deletes the blob. If `del` throws, the caller's
 * transaction rolls back (the row stays live) — same contract as before.
 */
export async function deleteBlobUnlessShared(
  tx: MediaBlobTx,
  media: { id: string; storageLocation: string },
): Promise<BlobDeleteOutcome> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${media.storageLocation}))`;

  const otherLiveReferences = await tx.mediaItem.count({
    where: {
      storageLocation: media.storageLocation,
      id: { not: media.id },
      deletedAt: null,
    },
  });
  if (otherLiveReferences > 0) {
    return "kept_shared";
  }

  await del(media.storageLocation);
  return "deleted";
}
