import type { Prisma } from "@prisma/client";
import { del } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";

/** The slice of a Prisma transaction client {@link deleteBlobUnlessShared} needs. */
export type MediaBlobTx = Pick<Prisma.TransactionClient, "$executeRaw" | "mediaItem">;

export type BlobDeleteOutcome = "deleted" | "kept_shared";

/**
 * How long one blob `del()` may run before it is aborted. `del(urlOrPathname,
 * options?)` takes the `abortSignal` of `BlobCommandOptions`, an "AbortSignal to
 * cancel the running request" (@vercel/blob 2.8.2 type declarations). 10 s keeps
 * a retention item (lock wait + count + delete + commit) inside the "one 15 s
 * item" bound that mediaRetentionBatch.ts budgets for.
 */
export const BLOB_DELETE_TIMEOUT_MS = 10_000;

/**
 * Removes a MediaItem's blob from storage ONLY when no other live
 * (non-purged, i.e. `deletedAt: null`) MediaItem — in ANY workspace — still
 * points at the same canonical blob URL (its `storageLocation` or a variant
 * spelling of it, see {@link guardBlobKey}).
 *
 * `POST /api/media` accepts any allowed blob URL, so two rows (even in
 * different workspaces) can reference one file; deleting the blob when either
 * is removed would silently destroy the other's media. "Purged" is defined
 * exactly as the retention sweep defines it: `deletedAt != null` means the row
 * was soft-deleted and its blob is already gone (or being removed).
 *
 * MUST run inside the transaction that already marked `media`'s own row as
 * deleted (`deletedAt` set) and holds its `FOR UPDATE` row lock: an
 * advisory lock keyed on the canonical URL then serializes concurrent deletes
 * of rows that share it, so two simultaneous deletes can't each see the other
 * as still live and both skip (which would leak the blob). The loser of the
 * lock sees the winner's commit and deletes the blob. If `del` throws, the
 * caller's transaction rolls back (the row stays live) — same contract as
 * before.
 *
 * 2026-11-02 scale audit (jobs): `del` is bounded by
 * {@link BLOB_DELETE_TIMEOUT_MS}. A hung Blob request used to hold the row lock,
 * the advisory lock and a pooled connection until the invocation was killed; the
 * abort now throws like any failed `del`, so the same rollback applies.
 */
export async function deleteBlobUnlessShared(
  tx: MediaBlobTx,
  media: { id: string; storageLocation: string },
): Promise<BlobDeleteOutcome> {
  // 2026-11-01 audit (M2): compare CANONICAL URLs, leniently. Legacy rows can
  // hold other spellings of the same file (stray whitespace, an upper-case host,
  // `:443`, but also a query, credentials, a port, or another store's host with
  // our pathname), and matching raw strings let a member `del()` a teammate's
  // blob through such a row. guardBlobKey() maps every spelling to one key; the
  // lock, the lookup and the delete all use it. The raw value is matched too, so
  // a value that cannot be keyed (unparseable, disallowed host) keeps the old
  // exact-match rule.
  const key = guardBlobKey(media.storageLocation);
  const spellings = key === media.storageLocation ? [key] : [key, media.storageLocation];

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

  const otherLiveReferences = await tx.mediaItem.count({
    where: {
      storageLocation: { in: spellings },
      id: { not: media.id },
      deletedAt: null,
    },
  });
  if (otherLiveReferences > 0) {
    return "kept_shared";
  }

  await del(key, { abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS) });
  return "deleted";
}
