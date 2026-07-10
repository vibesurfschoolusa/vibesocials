import type { MediaItem, Platform } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SavedFileInfo } from "@/server/storage";
import type { TikTokPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";

export interface CreatePostJobOnlyParams {
  userId: string;
  media: SavedFileInfo;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}

export interface PostJobCreated {
  postJobId: string;
  mediaItemId: string;
  resultIds: string[];
}

/** Reason a MediaItem can't be reused in a new post (Roadmap Phase 2). */
export type MediaItemUnavailableReason = "NOT_FOUND" | "MEDIA_DELETED";

/**
 * Typed error thrown by {@link assertMediaItemReusable} / {@link
 * createPostJobForExistingMedia} when a media item can't be reused. `code`
 * lets callers (the API route) map to the right HTTP status without string
 * matching `message`.
 */
export class MediaItemUnavailableError extends Error {
  readonly code: MediaItemUnavailableReason;

  constructor(code: MediaItemUnavailableReason, message: string) {
    super(message);
    this.name = "MediaItemUnavailableError";
    this.code = code;
  }
}

/**
 * Pure ownership/lifecycle guard for reusing an existing MediaItem in a new
 * post. Takes just the fields it needs (or `null` for "no row found") so it
 * is unit-testable without touching the database — mirrors the
 * `isMediaSweepEligible` pattern in `mediaRetention.ts`.
 *
 * Throws {@link MediaItemUnavailableError}; never returns a value.
 *  - `NOT_FOUND` — no row, or the row belongs to a different user (folded
 *    together deliberately: an owned-by-someone-else id must not reveal
 *    "it exists but isn't yours").
 *  - `MEDIA_DELETED` — the row exists and is owned, but its blob has already
 *    been removed (soft-deleted via `deletedAt`).
 */
export function assertMediaItemReusable(
  item: Pick<MediaItem, "userId" | "deletedAt"> | null,
  userId: string,
): void {
  if (!item || item.userId !== userId) {
    throw new MediaItemUnavailableError("NOT_FOUND", "Media item not found.");
  }
  if (item.deletedAt !== null) {
    throw new MediaItemUnavailableError(
      "MEDIA_DELETED",
      "This media has been deleted and can no longer be used.",
    );
  }
}

export async function createPostJobOnly(
  params: CreatePostJobOnlyParams,
): Promise<PostJobCreated> {
  const { userId, media, baseCaption, location, perPlatformOverrides } = params;

  const socialConnections = await prisma.socialConnection.findMany({
    where: { userId },
  });

  if (socialConnections.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }

  const metadata: { location?: { description: string } } = {};
  if (location) {
    metadata.location = { description: location };
  }

  // Roadmap Phase 1: this MediaItem is attached to a PostJob below, so stamp
  // `lastUsedAt` now. This drives age-based retention (set at attach time, not
  // just at run time, so a scheduled reuse that runs weeks later isn't treated
  // as stale). Never-posted library uploads via `POST /api/media` create no
  // PostJob and correctly leave `lastUsedAt = null`.
  const now = new Date();

  const mediaItem = await prisma.mediaItem.create({
    data: {
      userId,
      storageLocation: media.storageLocation,
      originalFilename: media.originalFilename,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      baseCaption,
      lastUsedAt: now,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      perPlatformOverrides: perPlatformOverrides
        ? (perPlatformOverrides as unknown as Record<string, string>)
        : undefined,
    },
  });

  const postJob = await prisma.postJob.create({
    data: {
      userId,
      mediaItemId: mediaItem.id,
      status: "in_progress",
    },
  });

  const resultRecords = await Promise.all(
    socialConnections.map(connection =>
      prisma.postJobResult.create({
        data: {
          postJobId: postJob.id,
          platform: connection.platform,
          socialConnectionId: connection.id,
          status: "pending",
        },
      })
    )
  );

  return {
    postJobId: postJob.id,
    mediaItemId: mediaItem.id,
    resultIds: resultRecords.map(r => r.id),
  };
}

export interface CreatePostJobForExistingMediaParams {
  userId: string;
  mediaItemId: string;
  /**
   * Accepted for parity with `CreatePostJobOnlyParams` / the request body so
   * callers can pass one options object, but — matching the "REVISED caption
   * source" note in the roadmap spec — this helper does NOT persist it. The
   * publisher (`inngest-functions.ts`) reads caption/overrides from the
   * `post/publish.requested` EVENT PAYLOAD, not from `MediaItem.baseCaption`,
   * so the caller must still put `baseCaption` in the event it sends (same as
   * the existing blobUrl path already does).
   */
  baseCaption: string;
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
  /**
   * Unlike caption/overrides, location IS read from the persisted
   * `MediaItem.metadata.location` at publish time (platform clients read it
   * off the refetched MediaItem — see `instagramClient.ts` /
   * `youtubeClient.ts`), so a new location for this reuse must be written
   * onto the existing row. Omitted/falsy leaves the row's existing location
   * untouched.
   */
  location?: string;
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  tiktokMetadata?: TikTokPostMetadata;
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  youtubeMetadata?: YouTubePostMetadata;
}

/**
 * Roadmap Phase 2 — create a PostJob that reuses an already-persisted
 * MediaItem instead of uploading a new one. Modeled on `createPostJobOnly`
 * but skips MediaItem creation entirely: it verifies the item exists, is
 * owned by `userId`, and hasn't been soft-deleted (`assertMediaItemReusable`,
 * throws `MediaItemUnavailableError` otherwise), then creates only the
 * PostJob + per-platform PostJobResults referencing the existing
 * `mediaItemId` and stamps `lastUsedAt = now` (Phase 1 retention: reusing is
 * itself a "use").
 *
 * The Inngest publisher already resolves media by id (refetches the
 * MediaItem row), so it needs NO changes — the caller sends the same
 * `post/publish.requested` event this helper's blobUrl sibling sends, with
 * caption/overrides/platform metadata in the payload.
 */
export async function createPostJobForExistingMedia(
  params: CreatePostJobForExistingMediaParams,
): Promise<PostJobCreated> {
  const { userId, mediaItemId, location } = params;

  const mediaItem = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
  });
  assertMediaItemReusable(mediaItem, userId);

  const socialConnections = await prisma.socialConnection.findMany({
    where: { userId },
  });

  if (socialConnections.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }

  const now = new Date();

  // Create the reuse job inside a transaction that FIRST locks the MediaItem row
  // (`SELECT ... FOR UPDATE`). This serializes against the retention sweep's
  // matching lock (inngest-functions.ts): if the sweep soft-deletes + removes the
  // blob first, our post-lock re-check sees `deletedAt` and aborts; if we create
  // the job first, the sweep sees the new non-terminal job and skips. Closes the
  // check-then-act reuse race the Phase-1 review flagged.
  const { postJob, resultRecords } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "MediaItem" WHERE id = ${mediaItemId} FOR UPDATE`;

    // Re-assert under the row lock — a concurrent sweep may have soft-deleted the
    // item between the initial check above and our acquiring the lock.
    const locked = await tx.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { userId: true, deletedAt: true },
    });
    assertMediaItemReusable(locked, userId);

    await tx.mediaItem.update({
      where: { id: mediaItemId },
      data: {
        // Attach-time stamp, same rationale as createPostJobOnly.
        lastUsedAt: now,
        // Only touch metadata when a new location was actually supplied, so a
        // reuse call that omits `location` doesn't clobber the item's existing
        // one (platform clients read it fresh from this row at publish time).
        ...(location ? { metadata: { location: { description: location } } } : {}),
      },
    });

    const job = await tx.postJob.create({
      data: {
        userId,
        mediaItemId,
        status: "in_progress",
      },
    });

    const results = await Promise.all(
      socialConnections.map(connection =>
        tx.postJobResult.create({
          data: {
            postJobId: job.id,
            platform: connection.platform,
            socialConnectionId: connection.id,
            status: "pending",
          },
        })
      )
    );

    return { postJob: job, resultRecords: results };
  });

  return {
    postJobId: postJob.id,
    mediaItemId,
    resultIds: resultRecords.map(r => r.id),
  };
}
