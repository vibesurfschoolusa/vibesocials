import { Platform, type MediaItem, type Prisma, type SocialConnection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

import type { SavedFileInfo } from "@/server/storage";
import type {
  FacebookPostMetadata,
  GoogleBusinessPostMetadata,
  InstagramPostMetadata,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";
import { coverJobColumns, type PostCover } from "@/lib/videoCover";
import { postJobStatusForIntent, type PostJobIntent } from "@/lib/scheduling";
import { platformAcceptsMedia, platformAcceptsTextOnly } from "@/lib/platformLimits";
import { connectionGoneMessage, reconnectRequiredMessage } from "@/lib/publishFailureText";
import { finishPostJob, recomputeAndStorePostJobStatus } from "@/server/jobs/failPendingResults";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";
import { SERVICE_DAILY_POST_LIMIT_CODE } from "@/lib/usageLimits";
import { BILLING_FIELDS_SELECT } from "@/lib/billing";
import { blockedResultFailure, PLAN_ENDED_CODE, WORKSPACE_PAUSED_CODE, workspaceBlock } from "@/lib/workspaceStatus";
import {
  FreeRunRefusedError,
  LimitCheckFailedError,
  recordSend,
  reserveFreeRuns,
  reserveFreeRunsIn,
  sendRecorded,
  type FreeRunReservation,
  type WrittenSends,
} from "@/server/usage/usageLog";
import {
  assertPostTargetsValid,
  assertTextPostTargetsValid,
  narrowConnectionsForPost,
  narrowConnectionsForTextPost,
} from "@/lib/postTargets";

/**
 * A new file of a post, as the create helper stores it. 07d: `altText` is the
 * photo's cleaned description (lib/altText.ts); absent writes no description.
 */
export type PostFileInfo = SavedFileInfo & { altText?: string };

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
  /**
   * Repeat (2026-11-10): create one job per time in `series.times`, all in
   * this helper's one transaction, sharing the files written once. Absent = the
   * single job, written exactly as before.
   */
  series?: PostSeriesParams;
  /**
   * The video's chosen cover (V1, lib/videoCover.ts), stored on every job of
   * the post for every intent; the publish and retry runs read it from the row.
   * Absent = the platforms pick their own, as before.
   */
  cover?: PostCover;
  /**
   * Feed and Story (Q1, 2026-11-14): also write a Story job, in this helper's
   * one transaction, beside the main job: the same file, caption, intent and
   * time, sent as a Story to `story.targetPlatforms` only. Never with a series
   * (the route refuses a Story that repeats). Absent = one job, as before.
   */
  story?: PostStoryJobParams;
  /**
   * Q1 fix 1: hold a member's Feed and Story pair for approval in this
   * helper's transaction, so both jobs are held or neither exists (the route
   * holds a single post after the create, as before). `intent` is `draft`;
   * `scheduledFor` is the member's chosen time, kept for the owner to honour.
   * A series is held through `series.submittedForApprovalAt` instead.
   */
  approvalHold?: PostApprovalHold;
}

export interface PostApprovalHold {
  submittedForApprovalAt: Date;
  scheduledFor: Date | null;
}

/** The columns that hold a non-series job for approval; none without a hold. */
function approvalHoldData(hold: PostApprovalHold | undefined) {
  if (!hold) return {};
  return {
    submittedForApprovalAt: hold.submittedForApprovalAt,
    ...(hold.scheduledFor ? { scheduledFor: hold.scheduledFor } : {}),
  };
}

/**
 * The Story job of a Feed and Story post: its platforms (a subset of the
 * post's) and each one's `{ placement: "story" }`, stored like any Story post.
 */
export interface PostStoryJobParams {
  targetPlatforms: Platform[];
  instagramMetadata?: InstagramPostMetadata;
  facebookMetadata?: FacebookPostMetadata;
}

/** The main job's connections narrowed to the Story job's platforms. */
function storyJobConnections<T extends { platform: Platform }>(story: PostStoryJobParams, targeted: T[]): T[] {
  return targeted.filter((connection) => story.targetPlatforms.includes(connection.platform));
}

/**
 * A series: one job per time (the first included, ascending), each carrying
 * `seriesId`. `intent` is `scheduled`, or `draft` with `submittedForApprovalAt`
 * for a member's series held for approval; each held job keeps its own time
 * for the owner to honour, as the route does for a single held post.
 */
export interface PostSeriesParams {
  seriesId: string;
  times: Date[];
  submittedForApprovalAt?: Date;
}

/**
 * The extra columns of one job of a series. Applied after
 * buildPostJobCreateData, which writes no time for a draft.
 */
function seriesJobData(series: PostSeriesParams | undefined, time: Date | undefined) {
  if (!series || !time) return {};
  return {
    seriesId: series.seriesId,
    ...(series.submittedForApprovalAt
      ? { scheduledFor: time, submittedForApprovalAt: series.submittedForApprovalAt }
      : {}),
  };
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
  /**
   * The post's first (or only) file: `PostJob.mediaItemId`. Null for a post that
   * is only text (2026-11-10): no MediaItem is written, the job's
   * `mediaItemId` is null, and only TEXT_ONLY_PLATFORMS may be targeted.
   */
  media: PostFileInfo | null;
  /**
   * Several photos in one post (07a): the photos after `media`, in order. Each
   * becomes its own MediaItem, and the post gets one PostJobMedia row per photo
   * (positions 0 to n-1, `media` first). Absent or empty = a single-file post,
   * written exactly as before (no PostJobMedia rows).
   */
  extraMedia?: PostFileInfo[];
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
  /**
   * R19 publishing L5: the post's location text, null for none. Written for
   * every job since then, so the job, not the shared Media item a reuse points
   * at, says where this post was. A job without the key was saved before and
   * keeps reading the Media item's location (see {@link postLocationOf}).
   */
  location?: string | null;
}

/**
 * The location a job's publish hands the clients: `{ location }` from its
 * snapshot (null: none), or nothing for a job saved before the snapshot had
 * the key, whose clients read the Media item's place as they did.
 */
export function postLocationOf(publishMetadata: unknown): { location?: string | null } {
  if (typeof publishMetadata !== "object" || publishMetadata === null || Array.isArray(publishMetadata)) return {};
  const location = (publishMetadata as { location?: unknown }).location;
  return typeof location === "string" || location === null ? { location } : {};
}

/**
 * Build the `publishMetadata` snapshot from the per-post metadata, or `undefined`
 * when none of the inputs has anything. buildPostJobCreateData adds the post's
 * location beside it, so every job created since R19 has one. Deferred jobs
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
  /** Feed and Story only: the Story job written beside `postJobId`. */
  storyPostJobId?: string;
  /** A series only: every job created, in time order; `postJobId` is the first. */
  postJobIds?: string[];
  /** Null for a post that is only text (createPostJobOnly with `media: null`). */
  mediaItemId: string | null;
  resultIds: string[];
  /**
   * Third review of K2: the sends this call wrote (a post going out now), for
   * the route to take back if handing it to publishing then fails.
   */
  sendsWritten?: WrittenSends;
  /**
   * R8-publishing M1: the jobs of a post going out now that have nothing to
   * send (every result failed at creation: not connected, or needs
   * reconnecting). The route sends no publish event for them, so they cost no
   * run. Absent when every job has something to send.
   */
  unsent?: string[];
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

/** A post's result row before its job exists; the caller adds `postJobId`. */
type FanOutResultRow = Omit<Prisma.PostJobResultCreateManyInput, "postJobId">;

/**
 * F1 H1 (R1 publishing; G1 for "Post now"): one result row per platform the post
 * goes to, so none can vanish silently. `eligible` are the connections the post
 * goes through, dead ones included; `connections` are all of the workspace's.
 * A healthy connection gets the `pending` row it always had, one that needs
 * reconnecting a `failed` RECONNECT_REQUIRED row, and a chosen platform with no
 * connection at all a `failed` CONNECTION_GONE row. Both failed rows say what to
 * do and can be retried once the platform is connected again. Shared by the
 * create helpers (immediate) and the deferred dispatch, so the sentences match.
 */
function buildFanOutResultRows(args: {
  workspaceId: string;
  eligible: ReadonlyArray<Pick<SocialConnection, "id" | "platform" | "needsReconnect">>;
  connections: ReadonlyArray<Pick<SocialConnection, "platform">>;
  targetPlatforms: readonly Platform[] | undefined;
}): FanOutResultRow[] {
  const { workspaceId } = args;
  const rows: FanOutResultRow[] = args.eligible.map((c) =>
    c.needsReconnect
      ? {
          workspaceId,
          platform: c.platform,
          socialConnectionId: c.id,
          status: "failed" as const,
          errorCode: "RECONNECT_REQUIRED",
          errorMessage: reconnectRequiredMessage(c.platform),
        }
      : {
          // 2026-11-01 scale audit (db M5): the job's workspace, denormalized.
          workspaceId,
          platform: c.platform,
          socialConnectionId: c.id,
          status: "pending" as const,
        },
  );
  for (const platform of args.targetPlatforms ?? []) {
    if (args.connections.some((c) => c.platform === platform)) continue;
    rows.push({
      workspaceId,
      platform,
      socialConnectionId: null,
      status: "failed",
      errorCode: "CONNECTION_GONE",
      errorMessage: connectionGoneMessage(platform),
    });
  }
  return rows;
}

/**
 * The rows of an immediate post and of its Story job, before anything is
 * written. NO_CONNECTIONS only when the workspace has nothing connected at all
 * (or nothing to post to): a chosen platform that needs reconnecting gets a
 * failed row instead, so the post shows it with Retry.
 */
function immediateFanOut(args: {
  workspaceId: string;
  connections: SocialConnection[];
  targeted: SocialConnection[];
  targetPlatforms: readonly Platform[] | undefined;
  story: PostStoryJobParams | undefined;
}): { rows: FanOutResultRow[]; storyRows: FanOutResultRow[] } {
  const { workspaceId, connections, targeted } = args;
  const rows = buildFanOutResultRows({
    workspaceId,
    eligible: targeted,
    connections,
    targetPlatforms: args.targetPlatforms,
  });
  if (connections.length === 0 || rows.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }
  const storyRows = args.story
    ? buildFanOutResultRows({
        workspaceId,
        eligible: storyJobConnections(args.story, targeted),
        connections,
        targetPlatforms: args.story.targetPlatforms,
      })
    : [];
  return { rows, storyRows };
}

/**
 * An immediate job's status follows its rows: `in_progress` while one is
 * pending (the publisher settles it), `failed` when every platform failed up
 * front. Deferred jobs keep their intent's status.
 */
function immediateJobStatus(intent: PostJobIntent, rows: readonly FanOutResultRow[]) {
  if (intent !== "immediate") return {};
  return { status: recomputePostJobStatus(rows.map((row) => ({ status: row.status ?? "pending" }))) };
}

/** A job of a post going out now has something to send: a pending result. */
function hasPending(rows: readonly FanOutResultRow[]): boolean {
  return rows.some((row) => (row.status ?? "pending") === "pending");
}

/** R8-publishing M1: the jobs of a post going out now with nothing to send, for PostJobCreated.unsent. */
function unsentImmediateJobs(
  intent: PostJobIntent,
  jobs: Array<[string | undefined, readonly FanOutResultRow[]]>,
): { unsent?: string[] } {
  if (intent !== "immediate") return {};
  const unsent = jobs.filter(([id, rows]) => id && !hasPending(rows)).map(([id]) => id as string);
  return unsent.length > 0 ? { unsent } : {};
}

/**
 * R8-publishing L2: whether the Story job of a post going out now would have
 * a result it can send (a pending one), by the rule immediateFanOut makes its
 * rows with, so the limits count it only then. Its platforms take any photo
 * or video the feed post was checked for. Counts it when the connections
 * cannot be read, so the limits err on the safe side.
 */
export async function immediateStoryCanSend(args: {
  workspaceId: string;
  story: PostStoryJobParams;
  targetPlatforms: readonly Platform[] | undefined;
}): Promise<boolean> {
  try {
    const connections = await prisma.socialConnection.findMany({ where: { workspaceId: args.workspaceId } });
    const targeted = args.targetPlatforms
      ? connections.filter((c) => args.targetPlatforms!.includes(c.platform))
      : connections;
    return hasPending(
      buildFanOutResultRows({
        workspaceId: args.workspaceId,
        eligible: storyJobConnections(args.story, targeted),
        connections,
        targetPlatforms: args.story.targetPlatforms,
      }),
    );
  } catch (error) {
    logger.error("[posting] Couldn't read the connections for a Story's limit check (counting it)", {
      error,
      workspaceId: args.workspaceId,
    });
    return true;
  }
}

/**
 * Review of T1, item 1: a post going out now reserves its runs (each job
 * that has something to publish; a pair as one unit) inside the create
 * transaction, under the service-wide lock for a free workspace. Past a
 * limit it throws FreeRunRefusedError, so the post and its results are
 * rolled back and the route answers with the sentence. The route takes back
 * the written runs if the hand-over then fails. R9-new-customer L2: when the
 * limits can't be checked it throws LimitCheckFailedError (rolled back the
 * same way; the route answers 503). The wait for the service-wide lock is
 * bounded (lock_timeout, for the rest of this transaction only), so a long
 * queue ends in that error well inside the transaction's own timeout.
 */
async function reserveImmediateRuns(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    intent: PostJobIntent;
    jobs: Array<[string | undefined, readonly FanOutResultRow[]]>;
    viewerUserId: string;
  },
): Promise<WrittenSends | undefined> {
  if (args.intent !== "immediate") return undefined;
  const sending = args.jobs.filter(([id, rows]) => id && hasPending(rows)).map(([id]) => id as string);
  if (sending.length === 0) return undefined;
  const day = new Date();
  let reservation: FreeRunReservation;
  try {
    await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
    reservation = await reserveFreeRunsIn(tx, {
      workspaceId: args.workspaceId,
      postJobIds: sending,
      at: day,
      check: "now",
      viewerUserId: args.viewerUserId,
    });
  } catch (error) {
    throw new LimitCheckFailedError(error);
  }
  if (!reservation.ok) throw new FreeRunRefusedError(reservation.refusal, reservation.ceiling ? day : null);
  return reservation.written.length > 0 ? { postJobIds: reservation.written, day } : undefined;
}

/** A create transaction waits for the service-wide lock behind other reservations. */
const CREATE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

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
  if (media) assertPostTargetsValid(targetPlatforms, media.mimeType, params.tiktokMetadata);
  else assertTextPostTargetsValid(targetPlatforms);

  // Only the immediate path materializes the fan-out (and thus requires a
  // connection) up front. Scheduled/draft jobs defer result creation to run
  // time (§6.3), so they can be created before any platform is connected.
  // Team Workspaces (Task 5): fan out over the WORKSPACE's connections, not
  // the caller's personal ones — any member's post reaches every platform
  // the shared workspace has connected.
  // Dead connections too (G1, R2 H1): their platforms get a failed row below.
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({
          where: { workspaceId },
        })
      : [];

  // Task 7 — narrow to the caller's chosen subset when given; `undefined`
  // means "every connection" (legacy/default behavior) — now minus the
  // connections whose client can't publish this media (2026-11-01 audit).
  const targeted =
    intent !== "immediate"
      ? []
      : media
        ? narrowConnectionsForPost({
            connections: socialConnections,
            targetPlatforms,
            mimeType: media.mimeType,
            tiktokMetadata: params.tiktokMetadata,
          })
        : narrowConnectionsForTextPost({ connections: socialConnections, targetPlatforms });

  const fanOut =
    intent === "immediate"
      ? immediateFanOut({ workspaceId, connections: socialConnections, targeted, targetPlatforms, story: params.story })
      : { rows: [], storyRows: [] };

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

  const createMediaItem = (tx: Prisma.TransactionClient, file: PostFileInfo) =>
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
        // 07d: only when there is one, so a post without descriptions writes today's row.
        ...(file.altText ? { altText: file.altText } : {}),
      },
    });
  // A post without a file has no photos after the first either.
  const extraMedia = media ? (params.extraMedia ?? []) : [];

  // Atomic media + job + results so a mid-path failure never leaves orphans
  // (mirrors createPostJobForExistingMedia).
  const { postJob, postJobs, mediaItem, resultRecords, storyJob, sendsWritten } = await prisma.$transaction(
    async (tx) => {
      const mediaItemRow = media ? await createMediaItem(tx, media) : null;
      // One after another, so the rows are created in the post's order.
      const extraRows = [];
      for (const file of extraMedia) {
        extraRows.push(await createMediaItem(tx, file));
      }

      // A series writes the files once and one job per time; every job points
      // at the same media rows.
      const jobs = [];
      for (const time of params.series?.times ?? [undefined]) {
        const created = await tx.postJob.create({
          data: {
            ...buildPostJobCreateData({
              userId,
              mediaItemId: mediaItemRow?.id ?? null,
              intent,
              scheduledFor: time ?? params.scheduledFor ?? null,
              baseCaption,
              perPlatformOverrides,
              tiktokMetadata: params.tiktokMetadata,
              youtubeMetadata: params.youtubeMetadata,
              googleMetadata: params.googleMetadata,
              instagramMetadata: params.instagramMetadata,
              facebookMetadata: params.facebookMetadata,
              targetPlatforms,
              cover: params.cover,
              location: location ?? null,
            }),
            ...immediateJobStatus(intent, fanOut.rows),
            workspaceId,
            ...seriesJobData(params.series, time),
            ...(params.series ? {} : approvalHoldData(params.approvalHold)),
          },
        });

        // Only a post with two or more photos gets rows; the first is the job's
        // own media item, so code that ignores this table publishes it.
        if (mediaItemRow && extraRows.length > 0) {
          await tx.postJobMedia.createMany({
            data: [mediaItemRow, ...extraRows].map((row, position) => ({
              postJobId: created.id,
              mediaItemId: row.id,
              position,
            })),
          });
        }
        jobs.push(created);
      }
      const job = jobs[0];

      const createResults = (postJobId: string, rows: FanOutResultRow[]) =>
        Promise.all(rows.map((row) => tx.postJobResult.create({ data: { postJobId, ...row } })));

      // Scheduled/draft jobs get NO results here (their rows are empty) — the
      // cron/promote create them at run time from the connections that exist then.
      const results = await createResults(job.id, fanOut.rows);

      // Feed and Story: the Story job, after the main one. A Story takes one
      // file, so it needs no PostJobMedia rows. A "Post now" Story gets a row
      // for each of its platforms, a failed one where it cannot be reached.
      let storyJob: { id: string } | null = null;
      if (params.story && (intent !== "immediate" || fanOut.storyRows.length > 0)) {
        storyJob = await tx.postJob.create({
          data: {
            ...buildPostJobCreateData({
              userId,
              mediaItemId: mediaItemRow?.id ?? null,
              intent,
              scheduledFor: params.scheduledFor ?? null,
              baseCaption,
              perPlatformOverrides,
              instagramMetadata: params.story.instagramMetadata,
              facebookMetadata: params.story.facebookMetadata,
              targetPlatforms: params.story.targetPlatforms,
              cover: params.cover,
              location: location ?? null,
            }),
            ...immediateJobStatus(intent, fanOut.storyRows),
            workspaceId,
            ...approvalHoldData(params.approvalHold),
            // F6: the pair's link, so the client review link and reports see one post.
            storyOfPostJobId: job.id,
          },
        });
        await createResults(storyJob.id, fanOut.storyRows);
      }

      const sendsWritten = await reserveImmediateRuns(tx, {
        workspaceId,
        intent,
        jobs: [
          [job.id, fanOut.rows],
          [storyJob?.id, fanOut.storyRows],
        ],
        viewerUserId: userId,
      });
      return { postJob: job, postJobs: jobs, mediaItem: mediaItemRow, resultRecords: results, storyJob, sendsWritten };
    },
    CREATE_TRANSACTION_OPTIONS,
  );
  const jobRows: Array<[string | undefined, readonly FanOutResultRow[]]> = [
    [postJob.id, fanOut.rows],
    [storyJob?.id, fanOut.storyRows],
  ];

  return {
    postJobId: postJob.id,
    ...(storyJob ? { storyPostJobId: storyJob.id } : {}),
    ...(params.series ? { postJobIds: postJobs.map((j) => j.id) } : {}),
    mediaItemId: mediaItem?.id ?? null,
    resultIds: resultRecords.map((r) => r.id),
    ...(sendsWritten ? { sendsWritten } : {}),
    ...unsentImmediateJobs(intent, jobRows),
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
  /** Null for a post that is only text. */
  mediaItemId: string | null;
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
  /** V1: the video's cover; no columns are written without one. */
  cover?: PostCover;
  /** R19 publishing L5: the post's location, null for none; snapshotted when given. */
  location?: string | null;
  // This pure builder deliberately does NOT take/stamp workspaceId — both
  // callers below merge it in directly (from their own required
  // `workspaceId` param) right at their `prisma.postJob.create` call, so this
  // function (and its existing unit tests) stay unchanged.
}): Omit<Prisma.PostJobUncheckedCreateInput, "workspaceId"> {
  // Always snapshot privacy + targeting when present so retry can replay the
  // user's compose-time choice (review S6). Immediate jobs still put privacy
  // on the event payload; the column is no longer deferred-only dead data.
  const options = buildPublishMetadataSnapshot(
    args.tiktokMetadata,
    args.youtubeMetadata,
    args.targetPlatforms,
    args.googleMetadata,
    args.instagramMetadata,
    args.facebookMetadata,
  );
  const publishMetadata: PublishMetadataSnapshot | undefined =
    args.location !== undefined ? { ...options, location: args.location } : options;
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
    ...coverJobColumns(args.cover),
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
   * Snapshotted on the new job like the caption (R19 publishing L5), never
   * written onto the shared, reused MediaItem: another post of the same item
   * must not take this post's place. Omitted/empty: the post has none.
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
  /**
   * 07d: the reused photo's new description, cleaned. Written onto the reused
   * item in the same update, only when sent and only for a photo; absent keeps
   * the description it has.
   */
  altText?: string;
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
  // Workspaces (Task 5): the workspace's connections, not the caller's; dead
  // ones too (G1, R2 H1), whose platforms get a failed row.
  const socialConnections =
    intent === "immediate"
      ? await prisma.socialConnection.findMany({
          where: { workspaceId },
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

  const fanOut =
    intent === "immediate"
      ? immediateFanOut({ workspaceId, connections: socialConnections, targeted, targetPlatforms, story: params.story })
      : { rows: [], storyRows: [] };

  const now = new Date();

  // Create the reuse job inside a transaction that FIRST locks the MediaItem row
  // (`SELECT ... FOR UPDATE`). This serializes against the retention sweep's
  // matching lock (inngest-functions.ts): if the sweep soft-deletes + removes the
  // blob first, our post-lock re-check sees `deletedAt` and aborts; if we create
  // the job first, the sweep sees the new non-terminal job and skips. Closes the
  // check-then-act reuse race the Phase-1 review flagged.
  const { postJob, postJobs, resultRecords, storyJob, sendsWritten } = await prisma.$transaction(async (tx) => {
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
        // 07d: the item was checked to be in this workspace under the lock above.
        ...(params.altText && mediaItem.mimeType.startsWith("image/") ? { altText: params.altText } : {}),
      },
    });

    // A series: one job per time, under the one lock taken above.
    const jobs = [];
    for (const time of params.series?.times ?? [undefined]) {
      jobs.push(
        await tx.postJob.create({
          data: {
            ...buildPostJobCreateData({
              userId,
              mediaItemId,
              intent,
              scheduledFor: time ?? params.scheduledFor ?? null,
              baseCaption,
              perPlatformOverrides,
              tiktokMetadata: params.tiktokMetadata,
              youtubeMetadata: params.youtubeMetadata,
              googleMetadata: params.googleMetadata,
              instagramMetadata: params.instagramMetadata,
              facebookMetadata: params.facebookMetadata,
              targetPlatforms,
              cover: params.cover,
              location: location ?? null,
            }),
            ...immediateJobStatus(intent, fanOut.rows),
            workspaceId,
            ...seriesJobData(params.series, time),
            ...(params.series ? {} : approvalHoldData(params.approvalHold)),
          },
        }),
      );
    }
    const job = jobs[0];

    const createResults = (postJobId: string, rows: FanOutResultRow[]) =>
      Promise.all(rows.map((row) => tx.postJobResult.create({ data: { postJobId, ...row } })));

    // Scheduled/draft reuse creates no results here (run-time creation, §6.3).
    const results = await createResults(job.id, fanOut.rows);

    // Feed and Story: the Story job, under the same lock (see createPostJobOnly).
    let storyJob: { id: string } | null = null;
    if (params.story && (intent !== "immediate" || fanOut.storyRows.length > 0)) {
      storyJob = await tx.postJob.create({
        data: {
          ...buildPostJobCreateData({
            userId,
            mediaItemId,
            intent,
            scheduledFor: params.scheduledFor ?? null,
            baseCaption,
            perPlatformOverrides,
            instagramMetadata: params.story.instagramMetadata,
            facebookMetadata: params.story.facebookMetadata,
            targetPlatforms: params.story.targetPlatforms,
            cover: params.cover,
            location: location ?? null,
          }),
          ...immediateJobStatus(intent, fanOut.storyRows),
          workspaceId,
          ...approvalHoldData(params.approvalHold),
          // F6: the pair's link, so the client review link and reports see one post.
          storyOfPostJobId: job.id,
        },
      });
      await createResults(storyJob.id, fanOut.storyRows);
    }

    const sendsWritten = await reserveImmediateRuns(tx, {
      workspaceId,
      intent,
      jobs: [
        [job.id, fanOut.rows],
        [storyJob?.id, fanOut.storyRows],
      ],
      viewerUserId: userId,
    });
    return { postJob: job, postJobs: jobs, resultRecords: results, storyJob, sendsWritten };
  }, CREATE_TRANSACTION_OPTIONS);
  const jobRows: Array<[string | undefined, readonly FanOutResultRow[]]> = [
    [postJob.id, fanOut.rows],
    [storyJob?.id, fanOut.storyRows],
  ];

  return {
    postJobId: postJob.id,
    ...(storyJob ? { storyPostJobId: storyJob.id } : {}),
    ...(params.series ? { postJobIds: postJobs.map((j) => j.id) } : {}),
    mediaItemId,
    resultIds: resultRecords.map(r => r.id),
    ...(sendsWritten ? { sendsWritten } : {}),
    ...unsentImmediateJobs(intent, jobRows),
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
  // Null for a post without a file. Such a post was created with its snapshot,
  // so the legacy fallback below never needs a media row for it.
  mediaItem: { baseCaption: string; perPlatformOverrides: Prisma.JsonValue | null } | null,
): PostCaptionSource {
  const source =
    job.baseCaption !== null
      ? { baseCaption: job.baseCaption, perPlatformOverrides: job.perPlatformOverrides }
      : {
          baseCaption: mediaItem?.baseCaption ?? "",
          perPlatformOverrides: mediaItem?.perPlatformOverrides ?? null,
        };
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
  /**
   * Null for a post that is only text (2026-11-10). The publish function decides
   * by the job row's own `mediaItemId`, not by this field.
   */
  mediaItemId: string | null;
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
  // `sendsWritten`: the sends this call's reservation wrote (itself, and the
  // other half of a pair it reserved), with their day, for a caller whose
  // hand-over then fails to take back. Absent when it wrote none.
  | { ok: true; event: PublishRequestedEventData; sendsWritten?: WrittenSends }
  | { ok: false; reason: "NOT_FOUND" | "NO_CONNECTIONS" }
  // R7-publishing L1: the workspace is paused or its plan ended; its results
  // say so, and nothing was checked against the caps or recorded.
  | { ok: false; reason: "BLOCKED" }
  // `noticeFor`: the post whose owner is told: the feed of a pair refused
  // together (one notice for both), else the refused post itself. `refusal`:
  // what its results say, for a route to answer with (absent on a re-run).
  | { ok: false; reason: "LIMIT_REACHED"; noticeFor: string; refusal?: SendRefusal };

type SendRefusal = { errorCode: string; errorMessage: string };

/** The other half of this post's Feed and Story pair, or null, with what its fan-out needs. */
function pairHalf(job: { id: string; storyOfPostJobId: string | null }) {
  const select = {
    id: true,
    status: true,
    publishMetadata: true,
    mediaItem: { select: { mimeType: true } },
    _count: { select: { results: true } },
  } as const;
  return job.storyOfPostJobId
    ? prisma.postJob.findUnique({ where: { id: job.storyOfPostJobId }, select })
    : prisma.postJob.findFirst({ where: { storyOfPostJobId: job.id }, select });
}

type FanOutSource = {
  workspaceId: string;
  publishMetadata: Prisma.JsonValue | null;
  mediaItem: { mimeType: string } | null;
};

/**
 * The result rows a deferred post gets from the connections that exist now:
 * the chosen platforms when its snapshot recorded them, else every connection
 * that can take its media (or text alone).
 */
function deferredFanOutRows(job: FanOutSource, connections: readonly SocialConnection[]): FanOutResultRow[] {
  // Replay the per-post privacy AND platform targeting the user chose at
  // compose time (review B1 / Task 7).
  const target = (job.publishMetadata as PublishMetadataSnapshot | null)?.targetPlatforms;
  // `eligible` narrows `connections` to the chosen subset when the snapshot
  // recorded one; `undefined`/empty means "all connections" (legacy
  // behavior). This also correctly subsumes the old "no connections at all"
  // case below: an empty `connections` filters to an empty `eligible` either way.
  //
  // 2026-11-01 audit (Task 9): with NO chosen list, "all connections" skips the
  // ones whose client can't publish this media (a YouTube result for an image
  // could only ever fail). An explicit list was validated against the media at
  // create time and is left exactly as chosen.
  // A post without a file goes only to the platforms that take text alone.
  const media = job.mediaItem ?? null;
  const eligible = target?.length
    ? connections.filter((c) => target.includes(c.platform))
    : media === null
      ? connections.filter((c) => platformAcceptsTextOnly(c.platform))
      : connections.filter((c) => platformAcceptsMedia(c.platform, media.mimeType));

  // Healthy connections keep exactly the rows they always had; the others say why.
  return buildFanOutResultRows({ workspaceId: job.workspaceId, eligible, connections, targetPlatforms: target });
}

/**
 * The other half of a Feed and Story pair when it is due with this one:
 * claimed by the same scan, not given its results yet, and (R7-publishing L2)
 * with a platform its connections let it send to. One already sent,
 * cancelled or failed, or with nothing to send, is not, and this half is
 * then checked alone.
 */
async function unsentPairHalf(
  job: { id: string; storyOfPostJobId: string | null; workspaceId: string },
  connections: readonly SocialConnection[],
): Promise<string | null> {
  const other = await pairHalf(job);
  if (!other || other.status !== "in_progress" || other._count.results !== 0) return null;
  return hasPending(deferredFanOutRows({ ...other, workspaceId: job.workspaceId }, connections)) ? other.id : null;
}

/**
 * R8-publishing L2: whether a draft or scheduled post going out now would get
 * a result it can send (a pending one), by the rule its results are made by
 * and unsentPairHalf uses, so the limits count its run only then. False for a
 * post that no longer exists; true when it cannot be read (counted, the safe
 * side for the limits).
 */
export async function deferredPostCanSend(postJobId: string): Promise<boolean> {
  try {
    const job = await prisma.postJob.findUnique({
      where: { id: postJobId },
      select: { workspaceId: true, publishMetadata: true, mediaItem: { select: { mimeType: true } } },
    });
    if (!job) return false;
    const connections = await prisma.socialConnection.findMany({ where: { workspaceId: job.workspaceId } });
    return hasPending(deferredFanOutRows(job, connections));
  } catch (error) {
    logger.error("[posting] Couldn't read whether a post can send (counting it)", { error, postJobId });
    return true;
  }
}


/** Results failed because the workspace is paused or its plan ended, and nothing pending or published. */
function refusedAsBlocked(results: readonly StoredResult[]): boolean {
  return (
    results.some((result) => result.errorCode === WORKSPACE_PAUSED_CODE || result.errorCode === PLAN_ENDED_CODE) &&
    !results.some((result) => result.status === "pending" || result.status === "success")
  );
}

type StoredResult = { status: string; errorCode: string | null };

/** Results failed with the at-send cap, and nothing pending or published. */
function refusedAtSend(results: readonly StoredResult[]): boolean {
  return (
    results.some((result) => result.errorCode === SERVICE_DAILY_POST_LIMIT_CODE) &&
    !results.some((result) => result.status === "pending" || result.status === "success")
  );
}

/**
 * On a re-run, whether this half was refused together with its other half:
 * both halves' results are failed with the at-send cap. A pair's halves share
 * one slot and are checked as one unit, so that happens only together; the
 * notice is then the feed's (one for both). Otherwise this half was refused
 * alone and is told its own.
 */
async function refusedWithPartner(job: { id: string; storyOfPostJobId: string | null }): Promise<boolean> {
  const other = await pairHalf(job);
  if (!other) return false;
  const results = await prisma.postJobResult.findMany({
    where: { postJobId: other.id },
    select: { status: true, errorCode: true },
  });
  return refusedAtSend(results);
}

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
 * shared item's caption, and overrides cleared by PATCH stay cleared.
 *
 * F1 H1 (R1 publishing): every chosen platform gets a result, so none can
 * vanish silently. One whose connection needs reconnecting gets a `failed`
 * RECONNECT_REQUIRED result, one with no connection at all a `failed`
 * CONNECTION_GONE result (no connection to point at); both say what to do and
 * can be retried once the platform is connected again. With no chosen list, the
 * same goes for every connection that could take the post. When nothing is left
 * to publish, the job's status is computed from those rows (`failed`) and the
 * caller gets NO_CONNECTIONS; only a job with no row at all is failed bare.
 *
 * Per-post TikTok/YouTube publishing metadata is
 * replayed from the job's `publishMetadata` snapshot (review B1) so the deferred
 * publish honors the privacy the user chose at compose time (a scheduled YouTube
 * "private" stays private, not silently escalated to the client-default unlisted).
 *
 * R6-security M2: `serviceCapAt` (the scanner, as a scheduled post falls due)
 * checks the service's daily cap before the results are made, for the post
 * and, when the other half of its Feed and Story pair is due with it, for
 * both as one unit (the review of K2: both go or neither). At the cap, every
 * platform that would have published gets a failed result that says why
 * (Retry is there from tomorrow), both halves of a pair, and the caller gets
 * LIMIT_REACHED. Review of T1, item 1: the check and the write are one
 * reservation (reserveFreeRuns, under the service-wide lock), and
 * publish and approve now pass `sendNow`, which checks the per-person
 * number too. Every post that goes out has its run for the day (the caps
 * count those), a pair's two at once.
 *
 * A re-run that finds the results already failed by the cap (a step retried
 * after the rows were written) is refused again: nothing is published, and
 * the status and the notice are redone, both idempotent.
 *
 * Third review of K2: it never takes a send back itself. It answers the
 * sends its reservation wrote, and only the caller, who knows what its own

 * attempt wrote (a feed reserves its Story's), takes them back.
 */
export async function prepareDeferredPostJobDispatch(
  postJobId: string,
  options: {
    /** The scanner, as a scheduled post falls due: the ceiling and the pools, with the at-send sentences. */
    serviceCapAt?: Date;
    /** Review of T1, item 1: publish or approve now (dispatchNow): every check, the per-person number too. */
    sendNow?: boolean;
    /**
     * Second look at T1, item 1: the route reserved this post's run before its
     * claim, so nothing is reserved or written here; the route takes it back.
     */
    reserved?: boolean;
    unitRefusal?: SendRefusal;
  } = {},
): Promise<DeferredDispatchResult> {
  const job = await prisma.postJob.findUnique({
    where: { id: postJobId },
    include: {
      mediaItem: { select: { baseCaption: true, perPlatformOverrides: true, mimeType: true } },
      // R7-publishing L1: the pause and plan columns, for the block check below.
      workspace: { select: { pausedAt: true, pausedReason: true, ...BILLING_FIELDS_SELECT } },
    },
  });

  if (!job) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  // Dead connections too (F1 H1): their platforms get a failed result below.
  const connections = await prisma.socialConnection.findMany({
    where: { workspaceId: job.workspaceId },
  });

  const publishMetadata =
    (job.publishMetadata as PublishMetadataSnapshot | null) ?? null;
  const rows: Prisma.PostJobResultCreateManyInput[] = deferredFanOutRows(job, connections).map((row) => ({
    postJobId,
    ...row,
  }));

  // Idempotent: only create the fan-out if it hasn't been created yet, so a
  // retried caller step never duplicates result rows.
  const existingResults = await prisma.postJobResult.count({ where: { postJobId } });
  const sendDay = options.serviceCapAt ?? new Date();
  const feedId = job.storyOfPostJobId ?? postJobId;

  if (rows.length === 0) {
    // No chosen list and no connection that could take the post → fail the job
    // (mirrors publishToAllPlatforms' no-connections path). §6.6.
    // The scheduled scanner tells the owner from its own step
    // (scannerNotice.ts) and buildPostOutcomeEmail has a dedicated
    // empty-results-failed subject. finishPostJob stamps the media's last use.
    await finishPostJob(prisma, { where: { id: postJobId }, data: { status: "failed" } });
    return { ok: false, reason: "NO_CONNECTIONS" };
  }

  // R7-publishing L1: a paused workspace, or one whose plan ended, sends
  // nothing, so its due post is failed here with that sentence, before any
  // cap check: no run is recorded, no cap notice goes out, no publish run.
  const block = job.workspace ? workspaceBlock(job.workspace, sendDay) : null;
  if (block && existingResults === 0) {
    const failure = blockedResultFailure(block.code);
    await prisma.postJobResult.createMany({
      data: rows.map((row) => (row.status === "pending" ? { ...row, status: "failed" as const, ...failure } : row)),
    });
    await recomputeAndStorePostJobStatus(postJobId);
    return { ok: false, reason: "BLOCKED" };
  }

  if (existingResults > 0) {
    const stored = await prisma.postJobResult.findMany({ where: { postJobId }, select: { status: true, errorCode: true } });
    if (refusedAsBlocked(stored)) {
      await recomputeAndStorePostJobStatus(postJobId);
      return { ok: false, reason: "BLOCKED" };
    }
    if (refusedAtSend(stored)) {
      await recomputeAndStorePostJobStatus(postJobId);
      const together = await refusedWithPartner(job);
      return { ok: false, reason: "LIMIT_REACHED", noticeFor: together ? feedId : postJobId };
    }
  }

  // The posts whose sends this one records: itself, or both halves of a pair.
  let sending = [postJobId];
  // The runs this call's reservation wrote.
  let reserved: string[] = [];
  const checked = Boolean(options.serviceCapAt || options.sendNow || options.unitRefusal || options.reserved);
  // A re-run that finds its results made has been past this check already.
  if (checked && !options.reserved && existingResults === 0 && rows.some((row) => row.status === "pending")) {

    const partner = options.unitRefusal ? null : await unsentPairHalf(job, connections);
    if (partner) sending = [postJobId, partner];
    let refusal = options.unitRefusal ?? null;
    // R8-publishing L1: a half whose run its other half reserved when the two
    // passed together is not checked again, so a pair is never split.
    const passedWithPartner = !refusal && !partner && (await sendRecorded(postJobId, sendDay));
    if (!refusal && !passedWithPartner) {
      // Review of T1, item 1: counted, checked and written in one transaction
      // under the service-wide lock; refused, nothing is written.
      const reservation = await reserveFreeRuns({
        workspaceId: job.workspaceId,
        postJobIds: sending,
        at: sendDay,
        check: options.serviceCapAt ? "atSend" : "now",
      });
      if (reservation.ok) reserved = reservation.written;
      else refusal = { errorCode: reservation.refusal.code, errorMessage: reservation.refusal.error };
    }
    if (refusal) {
      await prisma.postJobResult.createMany({
        data: rows.map((row) => (row.status === "pending" ? { ...row, status: "failed" as const, ...refusal } : row)),
      });
      await recomputeAndStorePostJobStatus(postJobId);
      // Its other half is refused with it; that half's own turn then finds it refused.
      if (partner) await prepareDeferredPostJobDispatch(partner, { unitRefusal: refusal });
      return { ok: false, reason: "LIMIT_REACHED", noticeFor: partner ? feedId : postJobId, refusal };
    }
  }

  if (existingResults === 0) {
    await prisma.postJobResult.createMany({ data: rows });
  }

  if (!rows.some((row) => row.status === "pending")) {
    // Nothing to publish: the job reads `failed` from its rows, and Activity
    // shows each platform's sentence and Retry. The scanner tells the owner.
    await recomputeAndStorePostJobStatus(postJobId);
    return { ok: false, reason: "NO_CONNECTIONS" };
  }

  // R6 review of K2: the send the caps count. Reserved above when checked;
  // otherwise (a re-run whose results were made) written once, if missing.
  const written = checked
    ? reserved
    : ((await recordSend({ workspaceId: job.workspaceId, postJobIds: sending, at: sendDay })) ?? []);

  const captionSource = resolvePostCaptionSource(job, job.mediaItem);

  return {
    ok: true,
    ...(written.length > 0 ? { sendsWritten: { postJobIds: written, day: sendDay } } : {}),
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
