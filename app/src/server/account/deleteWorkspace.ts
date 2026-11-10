import type { Prisma } from "@prisma/client";
import { del } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { BLOB_DELETE_TIMEOUT_MS } from "@/server/jobs/mediaBlob";

/**
 * Deleting a whole workspace: the stored-file cleanup and the row deletion,
 * shared by DELETE /api/workspaces/active and DELETE /api/auth/account.
 */

export const OTHER_OWNER_MESSAGE =
  "This workspace has another owner. Only a workspace with one owner can be deleted.";
export const POST_PUBLISHING_MESSAGE = "A post is publishing right now. Try again in a few minutes.";
export const LAST_WORKSPACE_MESSAGE =
  "This is your only workspace. To leave Vibe Socials, delete your account instead.";
export const WORKSPACE_FILES_FAILED_MESSAGE =
  "Could not delete all of this workspace's files. Try again.";
export const FINISH_FAILED_MESSAGE =
  "The files were removed, but the rest could not be finished. Try again to complete it.";

/**
 * Thrown inside a deletion transaction when a re-check fails, so the
 * transaction rolls back; the route answers 409 with `message`.
 */
export class DeletionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionRefusedError";
  }
}

/**
 * Files per Blob `del()` call, which takes an array. Each call is bounded by
 * BLOB_DELETE_TIMEOUT_MS (10 s), so 300 media items are 3 calls: at most
 * about 30 s even if every call runs to its timeout.
 */
export const BLOB_DELETE_BATCH_SIZE = 100;

/**
 * True when a post in any of these workspaces is being published now. Pass a
 * transaction client as `db` to check again inside the deletion transaction.
 */
export async function isPostPublishing(
  workspaceIds: string[],
  db: { postJob: Pick<Prisma.TransactionClient["postJob"], "findFirst"> } = prisma,
): Promise<boolean> {
  if (workspaceIds.length === 0) {
    return false;
  }
  const job = await db.postJob.findFirst({
    where: { workspaceId: { in: workspaceIds }, status: { in: ["pending", "in_progress"] } },
    select: { id: true },
  });
  return job !== null;
}

/**
 * Why `userId` (an owner of `workspaceId`) may not delete it, or null when
 * they may. Used by the route and by Settings to show the same sentence.
 */
export async function workspaceDeletionRefusal(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const [otherOwners, publishing, memberships] = await Promise.all([
    prisma.workspaceMember.count({
      where: { workspaceId, role: "owner", userId: { not: userId } },
    }),
    isPostPublishing([workspaceId]),
    prisma.workspaceMember.count({ where: { userId } }),
  ]);
  if (otherOwners > 0) return OTHER_OWNER_MESSAGE;
  if (publishing) return POST_PUBLISHING_MESSAGE;
  if (memberships <= 1) return LAST_WORKSPACE_MESSAGE;
  return null;
}

async function delWithTimeout(keys: string[]): Promise<void> {
  // A reason-less abort, as in mediaBlob.ts: the SDK fails fast on an
  // AbortError but retries a TimeoutError.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOB_DELETE_TIMEOUT_MS);
  try {
    await del(keys, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deletes the stored files of every live MediaItem in `workspaceIds`, except
 * a file a live MediaItem in some OTHER workspace still points at. Files are
 * compared by guardBlobKey (the key deleteBlobUnlessShared uses), and a file
 * shared only among the workspaces being deleted is deleted.
 *
 * Throws at the first failed batch. It changes no rows: the caller deletes
 * the workspace only after this resolves, so a failure leaves every row in
 * place. Files of earlier batches are already gone by then; a retry re-sends
 * them (Blob `del` of a missing file is not an error).
 */
export async function deleteWorkspaceFiles(workspaceIds: string[]): Promise<void> {
  const handled = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.mediaItem.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, storageLocation: true },
      orderBy: { id: "asc" },
      take: BLOB_DELETE_BATCH_SIZE,
    });
    if (page.length === 0) {
      return;
    }
    cursor = page[page.length - 1].id;

    const spellingsByKey = new Map<string, Set<string>>();
    for (const row of page) {
      const key = guardBlobKey(row.storageLocation);
      if (handled.has(key)) continue;
      const spellings = spellingsByKey.get(key) ?? new Set([key]);
      spellings.add(row.storageLocation);
      spellingsByKey.set(key, spellings);
    }

    if (spellingsByKey.size > 0) {
      const allSpellings = [...new Set([...spellingsByKey.values()].flatMap((set) => [...set]))];
      const elsewhere = await prisma.mediaItem.findMany({
        where: {
          storageLocation: { in: allSpellings },
          deletedAt: null,
          workspaceId: { notIn: workspaceIds },
        },
        select: { storageLocation: true },
      });
      const usedElsewhere = new Set(elsewhere.map((row) => row.storageLocation));

      const toDelete = [...spellingsByKey.entries()]
        .filter(([, spellings]) => ![...spellings].some((value) => usedElsewhere.has(value)))
        .map(([key]) => key);
      if (toDelete.length > 0) {
        await delWithTimeout(toDelete);
      }
      for (const key of spellingsByKey.keys()) {
        handled.add(key);
      }
    }

    if (page.length < BLOB_DELETE_BATCH_SIZE) {
      return;
    }
  }
}

/**
 * Deletes the Workspace rows. Members, invites, connections, pending
 * connections, media, posts (with their results) and metrics cascade.
 */
export async function deleteWorkspaceRows(
  tx: { workspace: Pick<Prisma.TransactionClient["workspace"], "deleteMany"> },
  workspaceIds: string[],
): Promise<void> {
  await tx.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
}
