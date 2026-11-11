import type { Prisma } from "@prisma/client";
import { del } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";
import { isLogoAddress } from "@/lib/workspaceLogo";

/** The slice of a Prisma transaction client {@link deleteBlobUnlessShared} needs. */
export type MediaBlobTx = Pick<Prisma.TransactionClient, "$executeRaw" | "mediaItem" | "workspace">;

/**
 * True when a workspace's report logo (Workspace.logoUrl) is this file. A logo
 * has no MediaItem row of its own, so a media row that points at one (the
 * logos/ prefix is refused at every client route, but a row may predate that)
 * must not delete it. Only addresses under logos/ are asked about: the server
 * stores every logo there and nowhere else (lib/workspaceLogo.ts), so other
 * files cost no query.
 */
export async function isLiveLogo(
  db: { workspace: Pick<Prisma.TransactionClient["workspace"], "count"> },
  key: string,
  spellings: string[],
): Promise<boolean> {
  if (!isLogoAddress(key)) return false;
  return (await db.workspace.count({ where: { logoUrl: { in: spellings } } })) > 0;
}

export type BlobDeleteOutcome = "deleted" | "kept_shared";

/**
 * How long one blob `del()` may run before it is aborted. `del(urlOrPathname,
 * options?)` takes the `abortSignal` of `BlobCommandOptions`, an "AbortSignal to
 * cancel the running request" (@vercel/blob 2.8.2 type declarations).
 *
 * The abort comes from an AbortController aborted with NO reason, never from
 * `AbortSignal.timeout()`: the SDK's request loop gives up only on a
 * DOMException named "AbortError", which is what a reason-less `abort()` leaves
 * as the reason; `AbortSignal.timeout()` aborts with a "TimeoutError", which the
 * SDK treats as a retryable failure and re-sends (async-retry, 10 retries with
 * backoff by default), so the delete would outlive the timeout. With the
 * AbortError the SDK fails fast with `BlobRequestAbortedError`.
 *
 * That makes 10 s the bound on the request. Prisma's 15 s transaction timeout in
 * mediaRetentionBatch.ts stays the outer bound of a whole item (lock wait + count
 * + delete + commit).
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
 * 2026-11-02 scale audit (jobs): `del` is aborted after
 * {@link BLOB_DELETE_TIMEOUT_MS} (an AbortController, see that constant for why
 * not `AbortSignal.timeout`). A hung Blob request used to hold the row lock, the
 * advisory lock and a pooled connection until the invocation was killed; the
 * SDK now rejects with `BlobRequestAbortedError`, which throws like any failed
 * `del`, so the same rollback applies. Prisma's transaction timeout (15 s for a
 * retention item) remains the outer bound.
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
  if (otherLiveReferences > 0 || (await isLiveLogo(tx, key, spellings))) {
    return "kept_shared";
  }

  // Created here, after the lock and the count, so a shared blob (which returns
  // above) starts no timer and the clock covers only the request itself.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOB_DELETE_TIMEOUT_MS);
  try {
    await del(key, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  return "deleted";
}
