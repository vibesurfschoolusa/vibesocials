import type { Prisma } from "@prisma/client";

import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { deleteBlobsWithTimeout } from "@/server/jobs/pendingBlobDeletion";

/**
 * Deleting a whole workspace, shared by DELETE /api/workspaces/active and
 * DELETE /api/auth/account.
 *
 * Order: ONE transaction takes the locks, runs every check, queues the stored
 * files that must go (PendingBlobDeletion) and deletes the rows. Only after it
 * commits are the files deleted, so a refusal can never come after a file is
 * gone. What the request does not finish stays queued for the hourly drain
 * (src/server/jobs/pendingBlobDeletion.ts).
 */

export const OTHER_OWNER_MESSAGE =
  "This workspace has another owner. Only a workspace with one owner can be deleted.";
export const POST_PUBLISHING_MESSAGE = "A post is publishing right now. Try again in a few minutes.";
export const LAST_WORKSPACE_MESSAGE =
  "This is your only workspace. To leave Vibe Socials, delete your account instead.";
export const WORKSPACE_DELETE_FAILED_MESSAGE =
  "Could not delete this workspace. Nothing was changed. Try again.";

/**
 * Thrown inside a deletion transaction when a check fails, so the
 * transaction rolls back; the route answers 409 with `message`.
 */
export class DeletionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionRefusedError";
  }
}

/** Media rows per page while queueing, and files per Blob `del()` after the commit. */
export const BLOB_DELETE_BATCH_SIZE = 100;
/** How long a request spends deleting queued files after its commit. */
export const AFTER_COMMIT_BUDGET_MS = 20_000;

type CountClient = { workspaceMember: Pick<Prisma.TransactionClient["workspaceMember"], "count"> };
type PostJobClient = { postJob: Pick<Prisma.TransactionClient["postJob"], "findFirst"> };

/**
 * Serializes with the leave and demote paths, which take the same key, so
 * owners cannot change between a deletion's checks and its commit.
 */
export async function lockWorkspaceOwners(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${workspaceId}`}))`;
}

/**
 * True when a post in any of these workspaces is being published now. Pass a
 * transaction client as `db` to check inside the deletion transaction.
 */
export async function isPostPublishing(
  workspaceIds: string[],
  db: PostJobClient = prisma,
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
 * they may. The route calls it inside its transaction; Settings calls it with
 * the default client to show the same sentence ahead of time.
 */
export async function workspaceDeletionRefusal(
  workspaceId: string,
  userId: string,
  db: CountClient & PostJobClient = prisma,
): Promise<string | null> {
  const otherOwners = await db.workspaceMember.count({
    where: { workspaceId, role: "owner", userId: { not: userId } },
  });
  if (otherOwners > 0) return OTHER_OWNER_MESSAGE;
  if (await isPostPublishing([workspaceId], db)) return POST_PUBLISHING_MESSAGE;
  const memberships = await db.workspaceMember.count({ where: { userId } });
  if (memberships <= 1) return LAST_WORKSPACE_MESSAGE;
  return null;
}

export type QueuedFile = { id: string; url: string };

/**
 * Inside the deleting transaction, before the rows go: queues one
 * PendingBlobDeletion per stored file of the live media in `workspaceIds`
 * that no live media item in a SURVIVING workspace uses. Files are compared
 * by guardBlobKey (the key deleteBlobUnlessShared uses, which also does the
 * blob host checks), and a file shared only among the workspaces being
 * deleted is queued once.
 */
export async function queueWorkspaceFiles(
  tx: Prisma.TransactionClient,
  workspaceIds: string[],
): Promise<QueuedFile[]> {
  const toQueue = new Set<string>();
  const handled = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await tx.mediaItem.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        deletedAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, storageLocation: true },
      orderBy: { id: "asc" },
      take: BLOB_DELETE_BATCH_SIZE,
    });
    if (page.length === 0) break;
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
      const elsewhere = await tx.mediaItem.findMany({
        where: {
          storageLocation: { in: allSpellings },
          deletedAt: null,
          workspaceId: { notIn: workspaceIds },
        },
        select: { storageLocation: true },
      });
      const usedElsewhere = new Set(elsewhere.map((row) => row.storageLocation));
      for (const [key, spellings] of spellingsByKey) {
        handled.add(key);
        if (![...spellings].some((value) => usedElsewhere.has(value))) {
          toQueue.add(key);
        }
      }
    }

    if (page.length < BLOB_DELETE_BATCH_SIZE) break;
  }

  if (toQueue.size === 0) {
    return [];
  }
  return tx.pendingBlobDeletion.createManyAndReturn({
    data: [...toQueue].map((url) => ({ url })),
    select: { id: true, url: true },
  });
}

/**
 * Deletes the stored files after the transaction committed. Batches of
 * BLOB_DELETE_BATCH_SIZE, for at most AFTER_COMMIT_BUDGET_MS in total; each
 * deleted batch has its queue rows removed. A failed batch, a batch not
 * reached, or a queue row that could not be removed stays queued for the
 * hourly drain. Never throws: the data is already gone, so the request
 * succeeds either way.
 */
export async function deleteQueuedFiles(
  files: QueuedFile[],
  opts: { now?: () => number } = {},
): Promise<{ deleted: number; left: number }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + AFTER_COMMIT_BUDGET_MS;
  let deleted = 0;

  for (let start = 0; start < files.length; start += BLOB_DELETE_BATCH_SIZE) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const batch = files.slice(start, start + BLOB_DELETE_BATCH_SIZE);
    try {
      await deleteBlobsWithTimeout(
        batch.map((file) => file.url),
        remaining,
      );
      await prisma.pendingBlobDeletion.deleteMany({ where: { id: { in: batch.map((file) => file.id) } } });
      deleted += batch.length;
    } catch (error) {
      logger.warn("[deleteWorkspace] Stored files left queued for the hourly drain", {
        count: batch.length,
        error,
      });
    }
  }

  return { deleted, left: files.length - deleted };
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
