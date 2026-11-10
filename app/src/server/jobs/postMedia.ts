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
 * A post's media in order: its `PostJobMedia` rows by position when it has any
 * (a post with two or more photos), else its one `PostJob.mediaItem`. Always at
 * least one item, and the first is always `PostJob.mediaItem`.
 *
 * Deleting a `MediaItem` cascades to its `PostJobMedia` row, so a missing photo
 * shows as positions that are not exactly 0 to n-1, as a post left with one
 * row, or as a first row that is not the post's media item. Each throws
 * {@link PostMediaUnavailableError}, as does a missing post. A soft-deleted item
 * (`deletedAt`) is returned as is: the caller decides, as it does today for a
 * post's single item.
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

  const complete =
    job.media.length >= 2 &&
    job.media.every((row, index) => row.position === index) &&
    job.media[0].mediaItem.id === job.mediaItemId;
  if (!complete) throw new PostMediaUnavailableError();

  return job.media.map((row) => row.mediaItem);
}
