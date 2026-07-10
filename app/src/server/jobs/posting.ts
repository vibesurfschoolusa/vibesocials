import type { MediaItem, Platform, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SavedFileInfo } from "@/server/storage";
import type { TikTokPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";
import { postJobStatusForIntent, type PostJobIntent } from "@/lib/scheduling";

/**
 * Fields shared by every create-post helper controlling WHEN/HOW the job runs
 * (Roadmap Phase 5). `intent` defaults to `immediate` (today's behavior:
 * results created up-front, publish event sent by the caller). For `scheduled`
 * / `draft`, the helper creates NO per-platform results and does NOT require a
 * connection — the fan-out is materialized at run time by the cron
 * due-scanner / publish-promote from the connections that exist THEN — and
 * snapshots the caption/overrides onto the PostJob so editing (PATCH) never
 * mutates shared reused media.
 */
export interface PostJobSchedulingParams {
  intent?: PostJobIntent;
  /** Target publish time; required (and only used) when `intent === "scheduled"`. */
  scheduledFor?: Date | null;
}

export interface CreatePostJobOnlyParams extends PostJobSchedulingParams {
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
  const intent = params.intent ?? "immediate";

  // Only the immediate path materializes the fan-out (and thus requires a
  // connection) up front. Scheduled/draft jobs defer result creation to run
  // time (§6.3), so they can be created before any platform is connected.
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({ where: { userId } })
      : [];

  if (intent === "immediate" && socialConnections.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }

  const metadata: { location?: { description: string } } = {};
  if (location) {
    metadata.location = { description: location };
  }

  // Roadmap Phase 1: this MediaItem is attached to a PostJob below, so stamp
  // `lastUsedAt` now. This drives age-based retention (set at attach time, not
  // just at run time, so a scheduled post that runs weeks later isn't treated
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
    data: buildPostJobCreateData({
      userId,
      mediaItemId: mediaItem.id,
      intent,
      scheduledFor: params.scheduledFor ?? null,
      baseCaption,
      perPlatformOverrides,
    }),
  });

  // Scheduled/draft jobs get NO results here — the cron/promote create them at
  // run time from the connections that exist then.
  const resultRecords =
    intent === "immediate"
      ? await Promise.all(
          socialConnections.map((connection) =>
            prisma.postJobResult.create({
              data: {
                postJobId: postJob.id,
                platform: connection.platform,
                socialConnectionId: connection.id,
                status: "pending",
              },
            }),
          ),
        )
      : [];

  return {
    postJobId: postJob.id,
    mediaItemId: mediaItem.id,
    resultIds: resultRecords.map(r => r.id),
  };
}

/**
 * Build the `PostJob.create` data for a given intent (Roadmap Phase 5). Shared
 * by both create helpers so the status/`scheduledFor`/caption-snapshot rule
 * lives in one place. Immediate jobs leave `scheduledFor`/`baseCaption`/
 * `perPlatformOverrides` null (caption travels in the event payload as before);
 * scheduled/draft jobs snapshot the composer content onto the job so it is
 * durable and editable without touching shared media.
 */
export function buildPostJobCreateData(args: {
  userId: string;
  mediaItemId: string;
  intent: PostJobIntent;
  scheduledFor: Date | null;
  baseCaption: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}): Prisma.PostJobUncheckedCreateInput {
  const isDeferred = args.intent !== "immediate";
  return {
    userId: args.userId,
    mediaItemId: args.mediaItemId,
    status: postJobStatusForIntent(args.intent),
    scheduledFor: args.intent === "scheduled" ? args.scheduledFor : null,
    baseCaption: isDeferred ? args.baseCaption : null,
    perPlatformOverrides:
      isDeferred && args.perPlatformOverrides
        ? (args.perPlatformOverrides as unknown as Prisma.InputJsonValue)
        : undefined,
  };
}

export interface CreatePostJobForExistingMediaParams
  extends PostJobSchedulingParams {
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
  const { userId, mediaItemId, location, baseCaption, perPlatformOverrides } =
    params;
  const intent = params.intent ?? "immediate";

  const mediaItem = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
  });
  assertMediaItemReusable(mediaItem, userId);

  // Immediate reuse materializes the fan-out now (and requires a connection);
  // scheduled/draft reuse defers result creation to run time (§6.3).
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({ where: { userId } })
      : [];

  if (intent === "immediate" && socialConnections.length === 0) {
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
      data: buildPostJobCreateData({
        userId,
        mediaItemId,
        intent,
        scheduledFor: params.scheduledFor ?? null,
        baseCaption,
        perPlatformOverrides,
      }),
    });

    // Scheduled/draft reuse creates no results here (run-time creation, §6.3).
    const results =
      intent === "immediate"
        ? await Promise.all(
            socialConnections.map((connection) =>
              tx.postJobResult.create({
                data: {
                  postJobId: job.id,
                  platform: connection.platform,
                  socialConnectionId: connection.id,
                  status: "pending",
                },
              }),
            ),
          )
        : [];

    return { postJob: job, resultRecords: results };
  });

  return {
    postJobId: postJob.id,
    mediaItemId,
    resultIds: resultRecords.map(r => r.id),
  };
}

/** Event payload for `post/publish.requested` (the shape `publishToAllPlatforms` reads). */
export interface PublishRequestedEventData {
  postJobId: string;
  userId: string;
  mediaItemId: string;
  baseCaption: string;
  perPlatformOverrides: Partial<Record<Platform, string>> | null;
}

/** Outcome of preparing a deferred (scheduled/draft) job for publishing. */
export type DeferredDispatchResult =
  | { ok: true; event: PublishRequestedEventData }
  | { ok: false; reason: "NOT_FOUND" | "NO_CONNECTIONS" };

/**
 * Roadmap Phase 5 — the review's KEY correctness fix (§6.3): materialize a
 * scheduled/draft job's per-platform `PostJobResult`s from the connections that
 * exist NOW (run time), not at schedule time. Pre-creating them at schedule
 * time breaks when connections change over the gap — a deleted connection
 * cascade-removes its result (silent vanish) and a newly added one has no result
 * and is never posted to.
 *
 * Shared by the cron due-scanner and the publish-draft endpoint. The caller
 * MUST have already atomically claimed the job (status → `in_progress`) so this
 * runs at most once per job. Returns the `post/publish.requested` payload to
 * send (caller sends it — via `step.sendEvent` in the cron for exactly-once, or
 * `inngest.send` in the route); on no connections it marks the job `failed`
 * (mirroring the existing no-connections path) and returns `ok: false`.
 *
 * Result creation is guarded by a "no results yet" check so a retried cron step
 * can't duplicate rows. Caption/overrides come from the job's own snapshot
 * (`PostJob.baseCaption` / `perPlatformOverrides`), falling back to the media
 * item — so a scheduled reuse uses the caption the user typed for THIS post, not
 * the shared item's caption. Per-post TikTok/YouTube publishing metadata is not
 * persisted for scheduled jobs, so publishing falls back to each client's SAFE
 * default (YouTube unlisted, TikTok SELF_ONLY) — same accepted limitation as the
 * retry path.
 */
export async function prepareDeferredPostJobDispatch(
  postJobId: string,
): Promise<DeferredDispatchResult> {
  const job = await prisma.postJob.findUnique({
    where: { id: postJobId },
    include: { mediaItem: { select: { baseCaption: true, perPlatformOverrides: true } } },
  });

  if (!job) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const connections = await prisma.socialConnection.findMany({
    where: { userId: job.userId },
  });

  if (connections.length === 0) {
    // No connections at run time → fail the job (mirrors publishToAllPlatforms'
    // no-connections path). §6.6.
    await prisma.postJob.update({
      where: { id: postJobId },
      data: { status: "failed" },
    });
    return { ok: false, reason: "NO_CONNECTIONS" };
  }

  // Idempotent: only create the fan-out if it hasn't been created yet, so a
  // retried caller step never duplicates result rows.
  const existingResults = await prisma.postJobResult.count({ where: { postJobId } });
  if (existingResults === 0) {
    await prisma.postJobResult.createMany({
      data: connections.map((c) => ({
        postJobId,
        platform: c.platform,
        socialConnectionId: c.id,
        status: "pending" as const,
      })),
    });
  }

  const overrides =
    (job.perPlatformOverrides as Partial<Record<Platform, string>> | null) ??
    (job.mediaItem.perPlatformOverrides as Partial<Record<Platform, string>> | null) ??
    null;

  return {
    ok: true,
    event: {
      postJobId,
      userId: job.userId,
      mediaItemId: job.mediaItemId,
      baseCaption: job.baseCaption ?? job.mediaItem.baseCaption,
      perPlatformOverrides: overrides,
    },
  };
}
