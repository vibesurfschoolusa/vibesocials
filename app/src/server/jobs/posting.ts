import { Platform, type MediaItem, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SavedFileInfo } from "@/server/storage";
import type {
  FacebookPostMetadata,
  GoogleBusinessPostMetadata,
  InstagramPostMetadata,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";
import { postJobStatusForIntent, type PostJobIntent } from "@/lib/scheduling";
import { platformAcceptsMedia } from "@/lib/platformLimits";
import { assertPostTargetsValid, narrowConnectionsForPost } from "@/lib/postTargets";

/**
 * Fields shared by every create-post helper controlling WHEN/HOW the job runs
 * (Roadmap Phase 5). `intent` defaults to `immediate` (today's behavior:
 * results created up-front, publish event sent by the caller). For `scheduled`
 * / `draft`, the helper creates NO per-platform results and does NOT require a
 * connection — the fan-out is materialized at run time by the cron
 * due-scanner / publish-promote from the connections that exist THEN. Every
 * intent snapshots the caption/overrides onto the PostJob, so editing (PATCH)
 * or retrying never reads or mutates shared reused media.
 */
export interface PostJobSchedulingParams {
  intent?: PostJobIntent;
  /** Target publish time; required (and only used) when `intent === "scheduled"`. */
  scheduledFor?: Date | null;
  /**
   * Per-post platform targeting (Task 7). The chosen subset of the user's
   * connected platforms to publish this post to. `undefined` = every
   * connection (legacy/default behavior — unchanged for existing callers).
   * For immediate jobs this narrows which connections get a `PostJobResult`
   * row (and thus the Inngest publisher's fan-out, since that derives its
   * work from existing result rows — see inngest-functions.ts). For
   * scheduled/draft jobs this rides the `publishMetadata` snapshot and is
   * replayed by {@link prepareDeferredPostJobDispatch} at run time.
   */
  targetPlatforms?: Platform[];
}

export interface CreatePostJobOnlyParams extends PostJobSchedulingParams {
  userId: string;
  /**
   * Team Workspaces (Task 5) — the tenant this job/media belongs to. Callers
   * pass the request's ACTIVE workspace (`getWorkspaceContext().workspace.id`),
   * not a workspace resolved from `userId` — a member acting in a shared
   * (non-personal) workspace must have their post land there, not in their
   * own personal workspace.
   */
  workspaceId: string;
  /** The post's first (or only) file: `PostJob.mediaItemId`. */
  media: SavedFileInfo;
  /**
   * Several photos in one post (07a): the photos after `media`, in order. Each
   * becomes its own MediaItem, and the post gets one PostJobMedia row per photo
   * (positions 0 to n-1, `media` first). Absent or empty = a single-file post,
   * written exactly as before (no PostJobMedia rows).
   */
  extraMedia?: SavedFileInfo[];
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
  /**
   * Per-post platform publishing metadata (Roadmap Phase 5 review B1). Carried
   * in the event payload for immediate posts; PERSISTED on the job (as
   * `publishMetadata`) for scheduled/draft so the deferred publish honors the
   * user's compose-time YouTube/TikTok privacy choice instead of a client
   * default. See {@link buildPublishMetadataSnapshot}.
   */
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  /** The Google post's options (2026-11-10); snapshotted like YouTube's privacy. */
  googleMetadata?: GoogleBusinessPostMetadata;
  /** Feed or Story (2026-11-10); snapshotted like the Google options. Absent: feed. */
  instagramMetadata?: InstagramPostMetadata;
  facebookMetadata?: FacebookPostMetadata;
}

/**
 * Persisted shape of `PostJob.publishMetadata` (Roadmap Phase 5 review B1) — the
 * per-platform publishing options a scheduled/draft post must replay at run time
 * so it publishes with the privacy the user chose, not each client's default.
 */
export interface PublishMetadataSnapshot {
  tiktok?: TikTokPostMetadata;
  youtube?: YouTubePostMetadata;
  /**
   * Task 7 — the chosen subset of platforms to publish to, replayed by
   * {@link prepareDeferredPostJobDispatch} at run time. Absent/empty means
   * "all connections" (legacy behavior). SEC-1: display-safe platform enum
   * values only.
   */
  targetPlatforms?: Platform[];
  /**
   * 2026-11-10 — the Google post's options. Absent means the post has none and
   * gets the workspace's default button at publish time.
   */
  googleBusinessProfile?: GoogleBusinessPostMetadata;
  /**
   * 2026-11-10 — Instagram's and Facebook's placement. Absent means feed; a
   * retry or a deferred publish without it would turn a Story into a feed post.
   */
  instagram?: InstagramPostMetadata;
  facebook?: FacebookPostMetadata;
}

/**
 * Build the `publishMetadata` snapshot from the per-post metadata, or `undefined`
 * when none of the three inputs has anything (so an immediate job / a job with
 * no per-post privacy or targeting leaves the column null). Deferred jobs
 * persist this; immediate jobs don't (their metadata rides the event — Task 7's
 * `targetPlatforms` is the exception: immediate jobs apply it directly to the
 * result-row fan-out instead of persisting it).
 */
export function buildPublishMetadataSnapshot(
  tiktokMetadata?: TikTokPostMetadata,
  youtubeMetadata?: YouTubePostMetadata,
  targetPlatforms?: Platform[],
  googleMetadata?: GoogleBusinessPostMetadata,
  instagramMetadata?: InstagramPostMetadata,
  facebookMetadata?: FacebookPostMetadata,
): PublishMetadataSnapshot | undefined {
  const hasTargetPlatforms = Boolean(targetPlatforms && targetPlatforms.length > 0);
  if (
    !tiktokMetadata &&
    !youtubeMetadata &&
    !hasTargetPlatforms &&
    !googleMetadata &&
    !instagramMetadata &&
    !facebookMetadata
  ) {
    return undefined;
  }
  return {
    ...(tiktokMetadata ? { tiktok: tiktokMetadata } : {}),
    ...(youtubeMetadata ? { youtube: youtubeMetadata } : {}),
    ...(hasTargetPlatforms ? { targetPlatforms } : {}),
    ...(googleMetadata ? { googleBusinessProfile: googleMetadata } : {}),
    ...(instagramMetadata ? { instagram: instagramMetadata } : {}),
    ...(facebookMetadata ? { facebook: facebookMetadata } : {}),
  };
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
 * Pure workspace/lifecycle guard for reusing an existing MediaItem in a new
 * post. Takes just the fields it needs (or `null` for "no row found") so it
 * is unit-testable without touching the database — mirrors the
 * `isMediaSweepEligible` pattern in `mediaRetention.ts`.
 *
 * Team Workspaces (Task 5): reuse eligibility is WORKSPACE-scoped, not
 * uploader-scoped — any member of the item's workspace may reuse it
 * (design §1 permission matrix: "Upload media, use library" is a member
 * action), matching the shared-library semantics `GET /api/media` already
 * exposes. `userId`/uploader identity plays no role here.
 *
 * Throws {@link MediaItemUnavailableError}; never returns a value.
 *  - `NOT_FOUND` — no row, or the row belongs to a different workspace
 *    (folded together deliberately: a foreign workspace's item id must not
 *    reveal "it exists but isn't yours").
 *  - `MEDIA_DELETED` — the row exists and is in-workspace, but its blob has
 *    already been removed (soft-deleted via `deletedAt`).
 */
export function assertMediaItemReusable<T extends Pick<MediaItem, "workspaceId" | "deletedAt">>(
  item: T | null,
  workspaceId: string,
): asserts item is T {
  if (!item || item.workspaceId !== workspaceId) {
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
  const { userId, workspaceId, media, baseCaption, location, perPlatformOverrides, targetPlatforms } =
    params;
  const intent = params.intent ?? "immediate";

  // 2026-11-01 audit (Task 9): an EXPLICIT platform list is validated for every
  // intent - against this media's type (a platform whose client rejects it is a
  // PostTargetingError, not a doomed result row) and the TikTok privacy rule -
  // before anything is written.
  assertPostTargetsValid(targetPlatforms, media.mimeType, params.tiktokMetadata);

  // Only the immediate path materializes the fan-out (and thus requires a
  // connection) up front. Scheduled/draft jobs defer result creation to run
  // time (§6.3), so they can be created before any platform is connected.
  // Team Workspaces (Task 5): fan out over the WORKSPACE's connections, not
  // the caller's personal ones — any member's post reaches every platform
  // the shared workspace has connected.
  // Healthy connections only — needsReconnect would just fail at the provider.
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({
          where: { workspaceId, needsReconnect: false },
        })
      : [];

  // Task 7 — narrow to the caller's chosen subset when given; `undefined`
  // means "every connection" (legacy/default behavior) — now minus the
  // connections whose client can't publish this media (2026-11-01 audit).
  const targeted =
    intent === "immediate"
      ? narrowConnectionsForPost({
          connections: socialConnections,
          targetPlatforms,
          mimeType: media.mimeType,
          tiktokMetadata: params.tiktokMetadata,
        })
      : [];

  if (intent === "immediate" && targeted.length === 0) {
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

  const createMediaItem = (tx: Prisma.TransactionClient, file: SavedFileInfo) =>
    tx.mediaItem.create({
      data: {
        userId,
        workspaceId,
        storageLocation: file.storageLocation,
        originalFilename: file.originalFilename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        baseCaption,
        lastUsedAt: now,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        perPlatformOverrides: perPlatformOverrides
          ? (perPlatformOverrides as unknown as Record<string, string>)
          : undefined,
      },
    });
  const extraMedia = params.extraMedia ?? [];

  // Atomic media + job + results so a mid-path failure never leaves orphans
  // (mirrors createPostJobForExistingMedia).
  const { postJob, mediaItem, resultRecords } = await prisma.$transaction(
    async (tx) => {
      const mediaItemRow = await createMediaItem(tx, media);
      // One after another, so the rows are created in the post's order.
      const extraRows = [];
      for (const file of extraMedia) {
        extraRows.push(await createMediaItem(tx, file));
      }

      const job = await tx.postJob.create({
        data: {
          ...buildPostJobCreateData({
            userId,
            mediaItemId: mediaItemRow.id,
            intent,
            scheduledFor: params.scheduledFor ?? null,
            baseCaption,
            perPlatformOverrides,
            tiktokMetadata: params.tiktokMetadata,
            youtubeMetadata: params.youtubeMetadata,
            googleMetadata: params.googleMetadata,
            instagramMetadata: params.instagramMetadata,
            facebookMetadata: params.facebookMetadata,
            targetPlatforms,
          }),
          workspaceId,
        },
      });

      // Only a post with two or more photos gets rows; the first is the job's
      // own media item, so code that ignores this table publishes it.
      if (extraRows.length > 0) {
        await tx.postJobMedia.createMany({
          data: [mediaItemRow, ...extraRows].map((row, position) => ({
            postJobId: job.id,
            mediaItemId: row.id,
            position,
          })),
        });
      }

      // Scheduled/draft jobs get NO results here — the cron/promote create them
      // at run time from the connections that exist then.
      const results =
        intent === "immediate"
          ? await Promise.all(
              targeted.map((connection) =>
                tx.postJobResult.create({
                  data: {
                    postJobId: job.id,
                    // 2026-11-01 scale audit (db M5): the denormalized workspace
                    // publish-health counts by; same value as the job's.
                    workspaceId,
                    platform: connection.platform,
                    socialConnectionId: connection.id,
                    status: "pending",
                  },
                }),
              ),
            )
          : [];

      return { postJob: job, mediaItem: mediaItemRow, resultRecords: results };
    },
  );

  return {
    postJobId: postJob.id,
    mediaItemId: mediaItem.id,
    resultIds: resultRecords.map((r) => r.id),
  };
}

/**
 * Build the `PostJob.create` data for a given intent (Roadmap Phase 5). Shared
 * by both create helpers so the status/`scheduledFor`/caption-snapshot rule
 * lives in one place. `scheduledFor` is set for scheduled jobs only. EVERY job
 * (2026-11-01 audit — previously deferred jobs only) snapshots the composer's
 * `baseCaption`/`perPlatformOverrides`, so the caption typed for THIS post is
 * durable: a retry and YouTube's title read it back job-first (see
 * {@link resolvePostCaptionSource}) instead of the shared MediaItem's, which a
 * reuse never rewrites. Immediate jobs still carry the caption in the event too.
 */
export function buildPostJobCreateData(args: {
  userId: string;
  mediaItemId: string;
  intent: PostJobIntent;
  scheduledFor: Date | null;
  baseCaption: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  googleMetadata?: GoogleBusinessPostMetadata;
  instagramMetadata?: InstagramPostMetadata;
  facebookMetadata?: FacebookPostMetadata;
  /** Task 7 — chosen platform subset, persisted for deferred jobs so
   *  {@link prepareDeferredPostJobDispatch} can replay it at run time. */
  targetPlatforms?: Platform[];
  // This pure builder deliberately does NOT take/stamp workspaceId — both
  // callers below merge it in directly (from their own required
  // `workspaceId` param) right at their `prisma.postJob.create` call, so this
  // function (and its existing unit tests) stay unchanged.
}): Omit<Prisma.PostJobUncheckedCreateInput, "workspaceId"> {
  // Always snapshot privacy + targeting when present so retry can replay the
  // user's compose-time choice (review S6). Immediate jobs still put privacy
  // on the event payload; the column is no longer deferred-only dead data.
  const publishMetadata = buildPublishMetadataSnapshot(
    args.tiktokMetadata,
    args.youtubeMetadata,
    args.targetPlatforms,
    args.googleMetadata,
    args.instagramMetadata,
    args.facebookMetadata,
  );
  return {
    userId: args.userId,
    mediaItemId: args.mediaItemId,
    status: postJobStatusForIntent(args.intent),
    scheduledFor: args.intent === "scheduled" ? args.scheduledFor : null,
    baseCaption: args.baseCaption,
    perPlatformOverrides: args.perPlatformOverrides
      ? (args.perPlatformOverrides as unknown as Prisma.InputJsonValue)
      : undefined,
    publishMetadata: publishMetadata
      ? (publishMetadata as unknown as Prisma.InputJsonValue)
      : undefined,
  };
}

export interface CreatePostJobForExistingMediaParams
  extends PostJobSchedulingParams {
  userId: string;
  /**
   * Team Workspaces (Task 5) — the ACTING caller's active workspace (see
   * {@link CreatePostJobOnlyParams.workspaceId}). Also the scope
   * {@link assertMediaItemReusable} checks the target MediaItem against — a
   * member may reuse ANY item in this workspace, regardless of who uploaded
   * it, but never an item from a different workspace.
   */
  workspaceId: string;
  mediaItemId: string;
  /**
   * Snapshotted onto the new PostJob (every intent — see
   * {@link buildPostJobCreateData}), never onto the shared, reused MediaItem —
   * matching the "REVISED caption source" note in the roadmap spec. The
   * initial publish reads caption/overrides from the `post/publish.requested`
   * EVENT PAYLOAD, so the caller must still put `baseCaption` in the event it
   * sends; a retry reads the job's snapshot back.
   */
  baseCaption: string;
  /** See `baseCaption` above: snapshotted on the job + carried by the event. */
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
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  googleMetadata?: GoogleBusinessPostMetadata;
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  instagramMetadata?: InstagramPostMetadata;
  /** See `baseCaption` above: carried by the event payload, not this helper. */
  facebookMetadata?: FacebookPostMetadata;
}

/**
 * Roadmap Phase 2 — create a PostJob that reuses an already-persisted
 * MediaItem instead of uploading a new one. Modeled on `createPostJobOnly`
 * but skips MediaItem creation entirely: it verifies the item exists, is IN
 * THE CALLER'S WORKSPACE, and hasn't been soft-deleted
 * (`assertMediaItemReusable`, throws `MediaItemUnavailableError` otherwise),
 * then creates only the PostJob + per-platform PostJobResults referencing the
 * existing `mediaItemId` and stamps `lastUsedAt = now` (Phase 1 retention:
 * reusing is itself a "use"). Team Workspaces (Task 5): reuse is
 * WORKSPACE-scoped, not uploader-scoped — any member may reuse any item in
 * their active workspace's shared library (design §1).
 *
 * The Inngest publisher already resolves media by id (refetches the
 * MediaItem row), so it needs NO changes — the caller sends the same
 * `post/publish.requested` event this helper's blobUrl sibling sends, with
 * caption/overrides/platform metadata in the payload.
 */
export async function createPostJobForExistingMedia(
  params: CreatePostJobForExistingMediaParams,
): Promise<PostJobCreated> {
  const {
    userId,
    workspaceId,
    mediaItemId,
    location,
    baseCaption,
    perPlatformOverrides,
    targetPlatforms,
  } = params;
  const intent = params.intent ?? "immediate";

  const mediaItem = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
  });
  assertMediaItemReusable(mediaItem, workspaceId);

  // 2026-11-01 audit (Task 9): the stored item's mimeType — not anything the
  // client sent — decides which platforms can publish it. See the blobUrl
  // sibling above.
  assertPostTargetsValid(targetPlatforms, mediaItem.mimeType, params.tiktokMetadata);

  // Immediate reuse materializes the fan-out now (and requires a connection);
  // scheduled/draft reuse defers result creation to run time (§6.3). Team
  // Workspaces (Task 5): the workspace's healthy connections, not the caller's.
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({
          where: { workspaceId, needsReconnect: false },
        })
      : [];

  // Task 7 — narrow to the caller's chosen subset when given; `undefined`
  // means "every connection" (legacy/default behavior) minus the connections
  // whose client can't publish this media (2026-11-01 audit).
  const targeted =
    intent === "immediate"
      ? narrowConnectionsForPost({
          connections: socialConnections,
          targetPlatforms,
          mimeType: mediaItem.mimeType,
          tiktokMetadata: params.tiktokMetadata,
        })
      : [];

  if (intent === "immediate" && targeted.length === 0) {
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
      select: { workspaceId: true, deletedAt: true },
    });
    assertMediaItemReusable(locked, workspaceId);

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
        ...buildPostJobCreateData({
          userId,
          mediaItemId,
          intent,
          scheduledFor: params.scheduledFor ?? null,
          baseCaption,
          perPlatformOverrides,
          tiktokMetadata: params.tiktokMetadata,
          youtubeMetadata: params.youtubeMetadata,
          googleMetadata: params.googleMetadata,
          instagramMetadata: params.instagramMetadata,
          facebookMetadata: params.facebookMetadata,
          targetPlatforms,
        }),
        workspaceId,
      },
    });

    // Scheduled/draft reuse creates no results here (run-time creation, §6.3).
    const results =
      intent === "immediate"
        ? await Promise.all(
            targeted.map((connection) =>
              tx.postJobResult.create({
                data: {
                  postJobId: job.id,
                  // 2026-11-01 scale audit (db M5): see createPostJobOnly.
                  workspaceId,
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

/** A post's caption source: its base caption (no footer) + per-platform overrides. */
export interface PostCaptionSource {
  baseCaption: string;
  perPlatformOverrides: Partial<Record<Platform, string>> | null;
}

/**
 * Where a post's caption comes from when it is (re)published from the DB. The
 * caption and its overrides are ONE snapshot: a job that has its own
 * `baseCaption` (every job since the 2026-11-01 audit) uses its own
 * `perPlatformOverrides` as-is — null means "no overrides" (never set, or
 * cleared by PATCH), never "fall back" to the shared MediaItem's overrides,
 * which were copied from the first upload and would resurrect text the user
 * deleted. Only a legacy job with no snapshot (`baseCaption` null) takes both
 * fields from the MediaItem. One rule for the deferred dispatch, the retry run
 * and YouTube's title, so a reused video never re-publishes another post's text.
 */
export function resolvePostCaptionSource(
  job: { baseCaption: string | null; perPlatformOverrides: Prisma.JsonValue | null },
  mediaItem: { baseCaption: string; perPlatformOverrides: Prisma.JsonValue | null },
): PostCaptionSource {
  const source =
    job.baseCaption !== null
      ? { baseCaption: job.baseCaption, perPlatformOverrides: job.perPlatformOverrides }
      : { baseCaption: mediaItem.baseCaption, perPlatformOverrides: mediaItem.perPlatformOverrides };
  return {
    baseCaption: source.baseCaption,
    perPlatformOverrides:
      (source.perPlatformOverrides as Partial<Record<Platform, string>> | null) ?? null,
  };
}

/** The platforms a post can publish to — the only override keys the publisher reads. */
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(Object.values(Platform));

/**
 * The platforms a job will publish to, or `null` when that can't be known yet.
 * Once the job has results (an immediate post, or a deferred one after its run-
 * time dispatch) those ARE the publish — and retry — targets. Before that, the
 * compose-time `publishMetadata.targetPlatforms` snapshot is what
 * {@link prepareDeferredPostJobDispatch} replays. With neither, the deferred
 * dispatch publishes to whatever connections exist at run time, which nothing
 * can know in advance.
 */
function jobPublishTargets(job: {
  publishMetadata?: Prisma.JsonValue | null;
  results?: ReadonlyArray<{ platform: Platform }>;
}): readonly Platform[] | null {
  if (job.results?.length) return job.results.map((result) => result.platform);
  const snapshot = (job.publishMetadata ?? null) as PublishMetadataSnapshot | null;
  return snapshot?.targetPlatforms?.length ? snapshot.targetPlatforms : null;
}

/**
 * 2026-11-01 audit (M1): the per-platform texts that will actually publish, for
 * showing to the owner who approves the post. An owner used to approve the base
 * caption only, while the publish path also used `perPlatformOverrides` nobody
 * had seen. This reads the overrides from {@link resolvePostCaptionSource} —
 * the very source the deferred dispatch, the retry and YouTube's title use — so
 * what the approver sees is what goes out, then narrows them like the
 * publisher does: only platforms the job targets (see `jobPublishTargets`; when
 * the targets can't be known, EVERY override shows, which over-informs rather
 * than hides), only real platforms, and only non-empty texts (the publisher
 * falls back to the base caption for an empty one). Returns the raw override
 * text — the workspace footer is appended at publish time — or `null` when
 * nothing would be replaced.
 */
export function resolvePlatformCaptions(
  job: {
    baseCaption: string | null;
    perPlatformOverrides: Prisma.JsonValue | null;
    publishMetadata?: Prisma.JsonValue | null;
    results?: ReadonlyArray<{ platform: Platform }>;
  },
  mediaItem:
    | { baseCaption: string; perPlatformOverrides: Prisma.JsonValue | null }
    | null
    | undefined,
): Partial<Record<Platform, string>> | null {
  // A job whose media row is gone has no legacy fallback to read.
  const { perPlatformOverrides } = resolvePostCaptionSource(
    job,
    mediaItem ?? { baseCaption: "", perPlatformOverrides: null },
  );
  if (!perPlatformOverrides) return null;

  const targets = jobPublishTargets(job);
  const captions: Partial<Record<Platform, string>> = {};
  for (const [key, text] of Object.entries(perPlatformOverrides)) {
    if (!KNOWN_PLATFORMS.has(key) || typeof text !== "string" || !text) continue;
    const platform = key as Platform;
    if (targets && !targets.includes(platform)) continue;
    captions[platform] = text;
  }
  return Object.keys(captions).length > 0 ? captions : null;
}

/** Event payload for `post/publish.requested` (the shape `publishToAllPlatforms` reads). */
export interface PublishRequestedEventData {
  postJobId: string;
  userId: string;
  /**
   * The job's workspace. The publish functions' per-workspace concurrency key is
   * evaluated against it (publishFlowControl.ts); the handler itself reads the
   * workspace off the job row, so an event enqueued before this field existed
   * still publishes.
   */
  workspaceId: string;
  mediaItemId: string;
  baseCaption: string;
  perPlatformOverrides: Partial<Record<Platform, string>> | null;
  /**
   * Per-post platform privacy replayed from the job's `publishMetadata` snapshot
   * (review B1). Omitted when the scheduled/draft post carried none — the client
   * then applies its default, same as an immediate post without metadata.
   */
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  /** 2026-11-10 — the Google post's options; omitted when the post has none. */
  googleMetadata?: GoogleBusinessPostMetadata;
  /** 2026-11-10 — feed or Story; omitted for a feed post. */
  instagramMetadata?: InstagramPostMetadata;
  facebookMetadata?: FacebookPostMetadata;
}

/**
 * 2026-11-01 scale audit (jobs H6 + H1): build the `post/publish.requested`
 * event every dispatcher sends. The id is stable per job (`publish-<postJobId>`),
 * and Inngest keeps an event id for 24 h, so a duplicate send of one job is
 * stored but triggers no run (https://www.inngest.com/docs/guides/handling-idempotency).
 * That is right because a job is dispatched at most once: every dispatcher first
 * moves it out of draft / scheduled / new. `immediate` feeds the function's
 * priority (PUBLISH_PRIORITY): true for a user's "Post now", false for the
 * scheduled scanner. Fields beyond {@link PublishRequestedEventData} (the posts
 * route's `location`) pass through unchanged.
 */
export function buildPublishEvent<T extends PublishRequestedEventData>(
  data: T,
  opts: { immediate: boolean },
): { id: string; name: "post/publish.requested"; data: T & { immediate: boolean } } {
  return {
    id: `publish-${data.postJobId}`,
    name: "post/publish.requested",
    data: { ...data, immediate: opts.immediate },
  };
}

/** The event {@link buildPublishEvent} builds. */
export type PublishEvent = ReturnType<typeof buildPublishEvent>;

/**
 * 2026-11-01 scale audit (jobs H6): build the `post/retry.requested` event. Unlike
 * a publish, a job can legitimately be retried more than once within Inngest's
 * 24 h event-id window, so the id carries a per-request part
 * (`retry-<postJobId>-<requestId>`, a fresh UUID from the route): it dedupes a
 * re-send of ONE request, never a second retry.
 */
export function buildRetryEvent(
  data: { postJobId: string; userId: string; workspaceId: string; platforms: Platform[] },
  requestId: string,
): { id: string; name: "post/retry.requested"; data: typeof data } {
  return {
    id: `retry-${data.postJobId}-${requestId}`,
    name: "post/retry.requested",
    data,
  };
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
 * (`PostJob.baseCaption` / `perPlatformOverrides`, as a unit — see
 * resolvePostCaptionSource), the media item only for legacy jobs without one —
 * so a scheduled reuse uses the caption the user typed for THIS post, not the
 * shared item's caption, and overrides cleared by PATCH stay cleared. Per-post TikTok/YouTube publishing metadata is
 * replayed from the job's `publishMetadata` snapshot (review B1) so the deferred
 * publish honors the privacy the user chose at compose time (a scheduled YouTube
 * "private" stays private, not silently escalated to the client-default unlisted).
 */
export async function prepareDeferredPostJobDispatch(
  postJobId: string,
): Promise<DeferredDispatchResult> {
  const job = await prisma.postJob.findUnique({
    where: { id: postJobId },
    include: {
      mediaItem: { select: { baseCaption: true, perPlatformOverrides: true, mimeType: true } },
    },
  });

  if (!job) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  // Skip dead connections — same filter as immediate create paths.
  const connections = await prisma.socialConnection.findMany({
    where: { workspaceId: job.workspaceId, needsReconnect: false },
  });

  // Replay the per-post privacy AND platform targeting the user chose at
  // compose time (review B1 / Task 7).
  const publishMetadata =
    (job.publishMetadata as PublishMetadataSnapshot | null) ?? null;
  const target = publishMetadata?.targetPlatforms;
  // `eligible` narrows `connections` to the chosen subset when the snapshot
  // recorded one; `undefined`/empty means "all connections" (legacy
  // behavior). This also correctly subsumes the old "no connections at all"
  // case below: an empty `connections` filters to an empty `eligible` either way.
  //
  // 2026-11-01 audit (Task 9): with NO chosen list, "all connections" skips the
  // ones whose client can't publish this media (a YouTube result for an image
  // could only ever fail). An explicit list was validated against the media at
  // create time and is left exactly as chosen.
  const eligible = target?.length
    ? connections.filter((c) => target.includes(c.platform))
    : connections.filter((c) => platformAcceptsMedia(c.platform, job.mediaItem.mimeType));

  if (eligible.length === 0) {
    // No eligible connections at run time → fail the job (mirrors
    // publishToAllPlatforms' no-connections path). §6.6. Covers both "no
    // connections at all" and "connections exist but none match the chosen
    // targetPlatforms" (Task 7).
    // The scheduled scanner emits notification.requested for this failure
    // (see inngest-functions.ts) and buildPostOutcomeEmail has a dedicated
    // empty-results-failed subject.
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
      data: eligible.map((c) => ({
        postJobId,
        // 2026-11-01 scale audit (db M5): the job's workspace, denormalized.
        workspaceId: job.workspaceId,
        platform: c.platform,
        socialConnectionId: c.id,
        status: "pending" as const,
      })),
    });
  }

  const captionSource = resolvePostCaptionSource(job, job.mediaItem);

  return {
    ok: true,
    event: {
      postJobId,
      userId: job.userId,
      workspaceId: job.workspaceId,
      mediaItemId: job.mediaItemId,
      baseCaption: captionSource.baseCaption,
      perPlatformOverrides: captionSource.perPlatformOverrides,
      // Only set when the snapshot has them, so a job with no per-post privacy
      // yields the same event shape as before (YouTube applies its private
      // default; TikTok refuses the post, since it may not pick a privacy level).
      ...(publishMetadata?.tiktok ? { tiktokMetadata: publishMetadata.tiktok } : {}),
      ...(publishMetadata?.youtube ? { youtubeMetadata: publishMetadata.youtube } : {}),
      ...(publishMetadata?.googleBusinessProfile
        ? { googleMetadata: publishMetadata.googleBusinessProfile }
        : {}),
      ...(publishMetadata?.instagram ? { instagramMetadata: publishMetadata.instagram } : {}),
      ...(publishMetadata?.facebook ? { facebookMetadata: publishMetadata.facebook } : {}),
    },
  };
}
