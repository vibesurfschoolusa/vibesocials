import type { MediaItem, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

/** Shown on a post's results when one of its photos can't be published. */
export const POST_PHOTO_UNAVAILABLE_MESSAGE = "One of this post's photos is no longer available.";

/** Thrown by {@link loadPostMediaItems} when the post's photos can't all be found. */
export class PostMediaUnavailableError extends Error {
  constructor() {
    super(POST_PHOTO_UNAVAILABLE_MESSAGE);
    this.name = "PostMediaUnavailableError";
  }
}

/**
 * Whether a post's PostJobMedia rows (ordered by position) still describe a
 * whole post with several photos: at least two rows, positions exactly 0 to n-1,
 * and the first row is the post's `PostJob.mediaItemId`.
 *
 * Deleting a `MediaItem` cascades to its row. That is caught when it leaves a
 * gap (any photo but the last), leaves one row, or removes the first photo (the
 * post's own media item, whose deletion cascades to the post itself anyway). A
 * deleted LAST photo is NOT caught: positions 0 to n-2 look like a whole post
 * with one photo fewer. Hard deletes of a MediaItem only come from deleting its
 * workspace or user (the app soft-deletes otherwise), which also deletes the
 * post, so this is a guard, not a guarantee. Soft deletes (`deletedAt`) are not
 * judged here; callers check them.
 */
export function isPostMediaComplete(
  mediaItemId: string,
  rows: ReadonlyArray<{ position: number; mediaItem: { id: string } }>,
): boolean {
  return (
    rows.length >= 2 &&
    rows.every((row, index) => row.position === index) &&
    rows[0].mediaItem.id === mediaItemId
  );
}

/**
 * A post's media in order: its `PostJobMedia` rows by position when it has any
 * (a post with two or more photos), else its one `PostJob.mediaItem`. Always at
 * least one item, and the first is always `PostJob.mediaItem`.
 *
 * Throws {@link PostMediaUnavailableError} for a missing post or for rows that
 * {@link isPostMediaComplete} rejects; see there for which missing photos that
 * catches (not a deleted last photo). A soft-deleted item (`deletedAt`) is
 * returned as is: the caller decides, as it does today for a post's single item.
 */
export async function loadPostMediaItems(
  postJobId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<MediaItem[]> {
  const job = await tx.postJob.findUnique({
    where: { id: postJobId },
    select: {
      mediaItemId: true,
      mediaItem: true,
      media: { orderBy: { position: "asc" }, select: { position: true, mediaItem: true } },
    },
  });
  if (!job) throw new PostMediaUnavailableError();
  if (job.media.length === 0) return [job.mediaItem];

  if (!isPostMediaComplete(job.mediaItemId, job.media)) throw new PostMediaUnavailableError();

  return job.media.map((row) => row.mediaItem);
}
