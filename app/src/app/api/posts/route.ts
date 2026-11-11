import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getWorkspaceContext, getWorkspaceMemberCount } from "@/lib/workspace";
import { workspaceBlockResponse } from "@/lib/workspaceStatus";
import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "@/lib/blobUrl";
import { findOverlongCaption, pickPlatformOverrides } from "@/lib/captionLimits";
import { captionTooLongResponse, invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { parsePostMediaFields, type PostMediaFields } from "@/lib/mediaInput";
import { readAltTextField, validatePostMediaList, type PostMediaEntry } from "@/lib/postMedia";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";
import { assertPostTargetsValid, PostTargetingError } from "@/lib/postTargets";
import { PostJobStatus, Platform, type Prisma } from "@prisma/client";
import {
  buildPublishEvent,
  createPostJobForExistingMedia,
  createPostJobOnly,
  MediaItemUnavailableError,
  resolvePlatformCaptions,
} from "@/server/jobs/posting";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { checkRateLimit } from "@/lib/rateLimit";
import { isValidPerPlatformOverrides, validateScheduledFor, type PostJobIntent } from "@/lib/scheduling";
import { deriveApprovalState, shouldHoldForApproval } from "@/lib/approval";
import { REPEAT_STORY_MESSAGE, validateRepeatAt } from "@/lib/repeatSchedule";
import { utcDayKey } from "@/lib/usageLimits";
import type {
  FacebookPostMetadata,
  GoogleBusinessPostMetadata,
  InstagramPostMetadata,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";
import { parseGooglePostMetadata } from "@/lib/googlePostOptions";
import {
  parsePlacementMetadata,
  storyMediaRefusal,
  storyPlatformsOf,
  withStoryCaptions,
  type StoryPlacementField,
  type StoryPlatform,
} from "@/lib/storyPlacement";
import { deferralKindFromErrorCode } from "@/lib/resultDeferral";
import type { PostsResponse } from "@/lib/postsDto";
import {
  isUnconfirmedResult,
  seriesPlaces,
  toPostJobDetailDto,
  toPostJobResultSummaryDto,
  encodePostsCursor,
  decodePostsCursor,
  METRIC_PLATFORMS,
} from "@/lib/postsDto";

/** Runtime set of valid PostJobStatus values, for the `?status=` filter. */
const VALID_POST_JOB_STATUSES = new Set<string>(Object.values(PostJobStatus));

const YOUTUBE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;

/** How many recent jobs the activity views load. */
const POSTS_PAGE_SIZE = 50;

/**
 * What the list reads per job: display fields, plus what the DTO derives from.
 * Shared by the page query and the Queue's client-change query below.
 */
const POSTS_LIST_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  // 2026-11-01 audit — the version an owner reviews; echoed back as the
  // approval route's `reviewedUpdatedAt` (CHANGED_SINCE_REVIEW guard).
  updatedAt: true,
  scheduledFor: true,
  baseCaption: true,
  // 2026-11-01 audit (M1): with the media item's caption + overrides and
  // `publishMetadata` / `results` below, everything `resolvePlatformCaptions`
  // reads to show the approver what will publish.
  perPlatformOverrides: true,
  // Approval workflow — feeds the derived `approvalState` DTO field.
  submittedForApprovalAt: true,
  approvedAt: true,
  // Client review link — the client's approval or change request.
  clientApprovedAt: true,
  clientChangeRequestedAt: true,
  clientNote: true,
  // Repeat (brief 11): the series it was created in, for "Repeats: 3 of 8".
  seriesId: true,
  mediaItem: {
    select: {
      baseCaption: true,
      perPlatformOverrides: true,
      storageLocation: true,
      mimeType: true,
    },
  },
  // Task 8 — compose-time publish snapshot (Task 7's `publishMetadata`),
  // surfaced read-only via the `publish` DTO field below.
  publishMetadata: true,
  // Team Workspaces (Task 4) — creator attribution for the `createdBy`
  // DTO field. Display fields only: name falls back to the email
  // local-part at map time below, and the full email NEVER reaches the
  // DTO (SEC-1).
  user: { select: { name: true, email: true } },
  results: {
    select: {
      platform: true,
      status: true,
      externalPostId: true,
      externalPostUrl: true,
      errorMessage: true,
      // Platform limits: with the status they say a result is waiting out a
      // rate limit or quota. `errorCode` is read only to tell a daily limit
      // from a rate limit; it never reaches the DTO (SEC-1).
      deferredUntil: true,
      errorCode: true,
    },
    orderBy: { platform: "asc" },
  },
} satisfies Prisma.PostJobSelect;

/**
 * Client review link: drafts a client asked to change that the Queue's first
 * page always carries (oldest request first), however old the post is.
 */
const CLIENT_CHANGES_FIRST_MAX = 20;

/**
 * GET /api/posts
 *
 * Additive, read-only list endpoint powering the dashboard "recent activity"
 * and the /activity view. Returns the authenticated user's most recent post
 * jobs with their per-platform results, projected to display-safe fields only
 * (SEC-1 discipline — no tokens, secrets, or raw connection metadata).
 */
export async function GET(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional `?status=` filter (Roadmap Phase 5) — a comma-separated list of
  // PostJobStatus values, e.g. `?status=scheduled,draft` for the Queue view.
  // Unknown values are ignored; if nothing valid remains the filter is dropped
  // (returns all), so a bad param can never 500 or silently return empty.
  const url = new URL(request.url);

  const statusParam = url.searchParams.get("status");
  const statusFilter = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_POST_JOB_STATUSES.has(s))
    : [];

  // Keyset pagination cursor (activity pagination) — an opaque base64url token
  // from a previous page's `nextCursor`. Decode it BEFORE any DB work so a
  // tampered/garbage value is a clean 400 with zero queries; absent or empty
  // means "first page" (no keyset predicate). See encode/decodePostsCursor.
  const cursorParam = url.searchParams.get("cursor");
  let cursor: { createdAt: Date; id: string } | null = null;
  if (cursorParam) {
    cursor = decodePostsCursor(cursorParam);
    if (!cursor) {
      return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    }
  }

  // Team Workspaces (Task 4) — any member sees every job in the active
  // workspace, not just their own (design doc §4/§7); `createdBy` (below)
  // is what lets the UI attribute each one to its creator.
  const where: Prisma.PostJobWhereInput = { workspaceId: context.workspace.id };
  if (statusFilter.length > 0) {
    where.status = { in: statusFilter as PostJobStatus[] };
  }
  // Keyset predicate for the (createdAt desc, id desc) total order: the page
  // AFTER the cursor (C, I) is every row strictly older in that order —
  // createdAt < C, or the same createdAt with a smaller id. ANDed with the
  // workspace + status filters above.
  if (cursor) {
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  try {
    const rows = await prisma.postJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: POSTS_PAGE_SIZE + 1,
      select: POSTS_LIST_SELECT,
    });

    // Keyset windowing (activity pagination): we over-fetch one row beyond the
    // page (take: POSTS_PAGE_SIZE + 1) to tell whether an older page exists
    // without a second COUNT query. If the probe row came back, drop it and
    // hand the client a cursor pointing at the last row we DO return; otherwise
    // this is the final page (nextCursor: null). Everything below — the metric
    // join and the DTO mapping — operates on the sliced `jobs`, unchanged.
    const hasMore = rows.length > POSTS_PAGE_SIZE;
    const pageJobs = hasMore ? rows.slice(0, POSTS_PAGE_SIZE) : rows;
    const lastJob = pageJobs[pageJobs.length - 1];
    const nextCursor =
      hasMore && lastJob ? encodePostsCursor(lastJob.createdAt, lastJob.id) : null;

    // Client review link: the Queue (opt-in `?clientChangesFirst=1`, first page
    // only, when drafts are asked for) also gets up to 20 drafts the client
    // asked to change, however old, so none hides behind "Load more". The
    // cursor above still follows the normal page; the Queue de-dupes a later
    // page by id. Every other caller pages exactly as before.
    const wantsClientChanges =
      url.searchParams.get("clientChangesFirst") === "1" &&
      !cursor &&
      (statusFilter.length === 0 || statusFilter.includes("draft"));
    const clientChanges = wantsClientChanges
      ? await prisma.postJob.findMany({
          where: {
            workspaceId: context.workspace.id,
            status: "draft",
            clientChangeRequestedAt: { not: null },
          },
          orderBy: [{ clientChangeRequestedAt: "asc" }, { id: "asc" }],
          take: CLIENT_CHANGES_FIRST_MAX,
          select: POSTS_LIST_SELECT,
        })
      : [];
    const clientChangeIds = new Set(clientChanges.map((job) => job.id));
    const jobs = [...clientChanges, ...pageJobs.filter((job) => !clientChangeIds.has(job.id))];

    // Roadmap Phase 8 (analytics): join the latest engagement snapshot per
    // result. Team Workspaces (Task 4): scoped to the active WORKSPACE, not
    // the caller — the jobs above already span every member (SEC: still
    // never global, just widened from "caller" to "caller's tenant") — and
    // joined by (platform, externalPostId) — the metric's DURABLE identity —
    // so it stays correct across a connection removal (the originating result
    // now survives with a null socialConnectionId; the metric row is keyed by
    // platform + externalPostId either way). YouTube, and since 2026-11-10
    // Instagram, Facebook, LinkedIn and Pinterest (METRIC_PLATFORMS). One
    // extra bounded query; a row matching an id of another platform is
    // dropped by the platform-and-id key below.
    const metricResults = jobs.flatMap((job) =>
      job.results.filter(
        (result) => METRIC_PLATFORMS.includes(result.platform) && Boolean(result.externalPostId),
      ),
    );
    const metricPlatforms = Array.from(new Set(metricResults.map((result) => result.platform)));
    const metricPostIds = Array.from(new Set(metricResults.map((result) => result.externalPostId as string)));

    const metricRows = metricPostIds.length
      ? await prisma.postMetric.findMany({
          where: {
            workspaceId: context.workspace.id,
            platform: { in: metricPlatforms },
            externalPostId: { in: metricPostIds },
          },
          // SEC-1: display fields only — never raw payload, id, userId, or the
          // postJobResultId link.
          select: {
            platform: true,
            externalPostId: true,
            views: true,
            likes: true,
            comments: true,
            shares: true,
            clicks: true,
            saves: true,
            fetchedAt: true,
          },
        })
      : [];

    const metricKey = (platform: string, externalPostId: string) => `${platform}:${externalPostId}`;
    const metricByPost = new Map(metricRows.map((row) => [metricKey(row.platform, row.externalPostId), row]));

    // 07a: a post with several photos has one PostJobMedia row per photo. One
    // grouped query for this page's ids (the (postJobId, position) index serves
    // it), not a `_count` in the page query, which Prisma renders as a join on
    // an aggregate over the whole table.
    const photoCountRows = jobs.length
      ? await prisma.postJobMedia.groupBy({
          by: ["postJobId"],
          where: { postJobId: { in: jobs.map((job) => job.id) } },
          _count: { _all: true },
        })
      : [];
    const photoCountByJobId = new Map(
      photoCountRows.map((row) => [row.postJobId, row._count._all]),
    );

    // Repeat (brief 11): every existing post of the page's series, not only the
    // ones on this page, so "3 of 8" counts the whole series. A series has at
    // most 12 posts, so this reads at most 12 rows per post on the page; the
    // seriesId index serves it.
    const seriesIds = Array.from(
      new Set(jobs.map((job) => job.seriesId).filter((id): id is string => Boolean(id))),
    );
    const seriesRows = seriesIds.length
      ? await prisma.postJob.findMany({
          where: { workspaceId: context.workspace.id, seriesId: { in: seriesIds } },
          select: { id: true, seriesId: true, scheduledFor: true, status: true },
        })
      : [];
    const placeByJobId = seriesPlaces(seriesRows);

    const payload: PostsResponse = {
      // 2026-11-01 scale audit (W3): counted here, on demand — it is no longer
      // a field of the workspace context every route pays for.
      workspaceMemberCount: await getWorkspaceMemberCount(context.workspace.id),
      // Approval workflow — lets the Queue decide between Approve/Reject
      // controls (owner) and a read-only awaiting badge (member).
      workspaceRole: context.role,
      workspaceRequireApproval: context.workspace.requireApproval,
      workspaceId: context.workspace.id,
      nextCursor,
      jobs: jobs.map((job) => {
        // Task 8 — the raw JSON snapshot narrowed to the display fields the
        // DTO exposes. Untyped at the Prisma boundary (Json?), so this cast
        // only asserts the shape we read from — never trusts it beyond that.
        const snapshot = job.publishMetadata as {
          tiktok?: { privacyLevel?: string };
          youtube?: { privacyStatus?: string };
          targetPlatforms?: string[];
          googleBusinessProfile?: { postType?: string; button?: { type?: string } };
        } | null;

        return {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          scheduledFor: job.scheduledFor?.toISOString() ?? null,
          // Approval workflow — derived, never a stored enum (lib/approval.ts).
          // 2026-11-10: which platforms this job sent as a Story.
          storyPlatforms: storyPlatformsOf(job.publishMetadata),
          approvalState: deriveApprovalState({
            submittedForApprovalAt: job.submittedForApprovalAt,
            approvedAt: job.approvedAt,
            status: job.status,
          }),
          // Client review link: the client's approval or change request.
          clientApprovedAt: job.clientApprovedAt?.toISOString() ?? null,
          clientChangeRequestedAt: job.clientChangeRequestedAt?.toISOString() ?? null,
          clientNote: job.clientNote ?? null,
          seriesId: job.seriesId ?? null,
          ...(placeByJobId.has(job.id)
            ? {
                seriesPosition: placeByJobId.get(job.id)!.position,
                seriesCount: placeByJobId.get(job.id)!.count,
              }
            : {}),
          // Scheduled/draft jobs snapshot their caption on the job itself so
          // editing them never mutates shared reused media; fall back to the
          // media item's caption for immediate/older jobs.
          caption: job.baseCaption ?? job.mediaItem?.baseCaption ?? null,
          // 2026-11-01 audit (M1): the per-platform texts the publish path will
          // use - the owner approves these too, not only `caption`.
          platformCaptions: resolvePlatformCaptions(job, job.mediaItem),
          // Display-only thumbnail source (SEC-1: storageLocation is a public
          // blob URL, already exposed via /api/media — no new secret surface).
          media: job.mediaItem
            ? { url: job.mediaItem.storageLocation, mimeType: job.mediaItem.mimeType }
            : null,
          // 07a: how many files the post has. A single-media post has no rows.
          mediaCount: photoCountByJobId.get(job.id) ?? 1,
          // Compose-time publish choices, null for legacy/immediate jobs with
          // no snapshot (see PublishMetadataSnapshot, src/server/jobs/posting.ts).
          publish: snapshot
            ? {
                targetPlatforms: (snapshot.targetPlatforms as Platform[] | undefined) ?? null,
                youtubePrivacy: snapshot.youtube?.privacyStatus ?? null,
                tiktokPrivacy: snapshot.tiktok?.privacyLevel ?? null,
                googlePostType: snapshot.googleBusinessProfile?.postType ?? null,
                googleButton: snapshot.googleBusinessProfile?.button?.type ?? null,
              }
            : null,
          // Team Workspaces (Task 4) — creator attribution. `name` falls back
          // to the email local-part; the full email never reaches the DTO
          // (SEC-1). `null` only if the creator relation is missing.
          createdBy: job.user
            ? { name: job.user.name ?? job.user.email.split("@")[0] }
            : null,
          results: job.results.map((result) => {
            const metricRow = result.externalPostId
              ? metricByPost.get(metricKey(result.platform, result.externalPostId))
              : undefined;
            return {
              platform: result.platform,
              status: result.status,
              externalPostId: result.externalPostId,
              externalPostUrl: result.externalPostUrl,
              errorMessage: result.errorMessage,
              // Only a pending result is waiting; a failed one that still has an
              // old deferredUntil (its run died) is not.
              deferral:
                result.status === "pending" && result.deferredUntil
                  ? {
                      kind: deferralKindFromErrorCode(result.errorCode),
                      until: result.deferredUntil.toISOString(),
                    }
                  : null,
              // 2026-11-01 scale audit (jobs H6): the commit call's outcome is
              // unknown, so the card warns inline. Only a failed result counts
              // (PUBLISH_UNCONFIRMED, or TikTok's TIKTOK_PUBLISH_PENDING; final
              // review F4); errorCode itself stays server-side (SEC-1).
              unconfirmed: isUnconfirmedResult(result),
              metric: metricRow
                ? {
                    views: metricRow.views,
                    likes: metricRow.likes,
                    comments: metricRow.comments,
                    shares: metricRow.shares,
                    clicks: metricRow.clicks,
                    saves: metricRow.saves,
                    fetchedAt: metricRow.fetchedAt.toISOString(),
                  }
                : null,
            };
          }),
        };
      }),
    };

    return NextResponse.json(payload);
  } catch (error: unknown) {
    logger.error("[GET /api/posts] Unexpected error", {
      error,
      userId: context.user.id,
      workspaceId: context.workspace.id,
    });
    return NextResponse.json(
      { error: "Failed to load posts" },
      { status: 500 },
    );
  }
}

// Shape of the JSON POST body. Fields the handler validates at runtime are
// typed `unknown` (narrowed at use); the rest reflect their consumed types.
// `mediaItemId` (Roadmap Phase 2) is the additive reuse path: a body with
// `mediaItemId` and no `blobUrl` skips upload and re-attaches an existing,
// already-persisted MediaItem instead.
interface CreatePostBody {
  blobUrl?: string;
  mediaItemId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  // Several photos in one post (07a): 1 to MAX_POST_MEDIA files, in order, each
  // `{ blobUrl, filename, mimeType, sizeBytes, altText? }`. Never together with
  // `blobUrl` / `mediaItemId`; one entry is the same as those blob fields.
  media?: unknown;
  // 07d: the photo's description, beside `blobUrl` or `mediaItemId` (and in
  // each `media` entry). Ignored for a video; absent keeps a reused photo's own.
  altText?: unknown;
  baseCaption?: unknown;
  location?: unknown;
  perPlatformOverrides?: unknown;
  tiktokMetadata?: unknown;
  youtubeMetadata?: { privacyStatus?: unknown };
  // 2026-11-10 — the Google post's options (lib/googlePostOptions.ts).
  googleMetadata?: unknown;
  // 2026-11-10 — feed or Story, `{ placement }` (lib/storyPlacement.ts).
  instagramMetadata?: unknown;
  facebookMetadata?: unknown;
  // Task 7 — optional chosen subset of platforms to publish this post to.
  // Absent = every connected platform (legacy/default behavior).
  platforms?: unknown;
  // Roadmap Phase 5. `draft: true` saves a draft (no results, no event);
  // `scheduledFor` (ISO string) schedules for later (no results, no event —
  // the cron claims it when due). Absent both = immediate (today's behavior).
  draft?: unknown;
  scheduledFor?: unknown;
  // 11: 1 to 11 further ISO instants, only with `scheduledFor`; one post is
  // created per instant, all in one transaction (lib/repeatSchedule.ts).
  repeatAt?: unknown;
  // 2026-11-01 audit (M3): the workspace the composer was rendered for. Optional
  // for API compatibility; when present it must equal the active workspace.
  workspaceId?: unknown;
}

/** 400 for a rejected platform choice; `code` + `platforms` let a client react without parsing `error`. */
function postTargetingErrorResponse(error: PostTargetingError) {
  return NextResponse.json(
    { error: error.message, code: error.code, platforms: error.platforms },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pause (2026-11-10): a paused workspace cannot create or move work.
  const blocked = workspaceBlockResponse(context.workspace);
  if (blocked) return blocked;

  // Roadmap Phase 2 (spec §1.2): POST /api/posts triggers live
  // multi-platform publishing — the heaviest external action in the app —
  // and was unlimited until now. Shared by both the blobUrl and mediaItemId
  // (reuse) creation paths below; checked right after auth, before any
  // parsing/DB work. Team Workspaces (Task 4): keyed by user id, not
  // workspace — a per-member throttle, same as every other rate-limited route.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "posts/publish",
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many posts created recently. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 400 },
    );
  }

  // `null` / an array / a primitive is valid JSON but not a body we can index.
  const parsedBody = await readJsonObject(request);
  if (!parsedBody) {
    return invalidJsonBodyResponse();
  }
  const body = parsedBody as CreatePostBody;

  // 2026-11-01 audit (M3): the active workspace is a cookie shared by every
  // tab, so a switch in another tab re-points THIS tab's request — a member's
  // "Submit for approval?" would publish live as the owner of the new
  // workspace. The composer sends the workspace id it was rendered for; refuse
  // on a mismatch. Deliberately the FIRST check after the body is read: nothing
  // below (blob URL canonicalisation, media/job rows, notifications, the
  // publish event) may run for a request meant for another workspace. An absent
  // field keeps today's behaviour for API clients; JSON `null` is present, so
  // it is rejected like any other non-string.
  if (body.workspaceId !== undefined) {
    if (typeof body.workspaceId !== "string") {
      return NextResponse.json(
        { error: INVALID_WORKSPACE_ID_MESSAGE, code: INVALID_WORKSPACE_ID_CODE },
        { status: 400 },
      );
    }
    if (body.workspaceId !== context.workspace.id) {
      return NextResponse.json(
        { error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE },
        { status: 409 },
      );
    }
  }

  const hasMediaList = body?.media != null;
  if (hasMediaList && (body.blobUrl != null || body.mediaItemId != null)) {
    return NextResponse.json(
      { error: "Send either media or blobUrl / mediaItemId, not both." },
      { status: 400 },
    );
  }

  const hasBlobUrl = typeof body?.blobUrl === "string" && body.blobUrl.trim().length > 0;
  const hasMediaItemId =
    typeof body?.mediaItemId === "string" && body.mediaItemId.trim().length > 0;
  // blobUrl wins if a caller somehow sends both, preserving the original
  // (pre-Phase-2) path byte-for-byte for every existing caller.
  const usingExistingMedia = hasMediaItemId && !hasBlobUrl && !hasMediaList;

  if (!hasBlobUrl && !usingExistingMedia && !hasMediaList) {
    return NextResponse.json(
      { error: "blobUrl or mediaItemId is required" },
      { status: 400 },
    );
  }

  // The blobUrl path creates a MediaItem from the client-supplied metadata, so
  // it is validated (reuse of an existing item ignores these fields).
  let mediaFields: PostMediaFields | undefined;
  // 2026-11-01 audit (M2): the canonical spelling is what gets stored (this path
  // used to store `body.blobUrl` untrimmed), so the shared-blob guard
  // (deleteBlobUnlessShared) can't be bypassed by a variant URL.
  let storedBlobUrl: string | undefined;
  // Several photos (07a): the photos after the first, in order. Stays undefined
  // for one file, so a one-entry list takes the blobUrl path unchanged.
  let extraMedia: PostMediaEntry[] | undefined;
  // 07d: the first (or only) file's cleaned description; undefined for none or a
  // video. The files after it carry their own in `extraMedia`. The create
  // helper writes them with the media rows, in the post's transaction.
  let firstAltText: string | undefined;
  if (hasMediaList) {
    const listValidation = validatePostMediaList(body.media);
    if (!listValidation.ok) {
      return NextResponse.json({ error: listValidation.error }, { status: 400 });
    }
    const [first, ...rest] = listValidation.value;
    storedBlobUrl = first.storageLocation;
    mediaFields = { filename: first.originalFilename, mimeType: first.mimeType, sizeBytes: first.sizeBytes };
    firstAltText = first.altText;
    // An entry carries `altText` only when it has one (validatePostMediaList).
    if (rest.length > 0) extraMedia = rest;
  } else if (hasBlobUrl) {
    const canonical = canonicalBlobUrl(body.blobUrl as string);
    if (!canonical) {
      return NextResponse.json({ error: BLOB_URL_REJECTED_MESSAGE }, { status: 400 });
    }
    storedBlobUrl = canonical;
    const mediaValidation = parsePostMediaFields(body);
    if (!mediaValidation.ok) {
      return NextResponse.json({ error: mediaValidation.error }, { status: 400 });
    }
    mediaFields = mediaValidation.value;
  }
  if (!hasMediaList) {
    // The reuse path has no mimeType here: the write is limited to photos.
    const altText = readAltTextField(body.altText, mediaFields?.mimeType ?? "image/");
    if (!altText.ok) {
      return NextResponse.json({ error: altText.error }, { status: 400 });
    }
    firstAltText = altText.value;
  }

  const baseCaptionRaw = body?.baseCaption;
  const locationRaw = body?.location;
  const overridesRaw = body?.perPlatformOverrides;
  const tiktokMetadataRaw = body?.tiktokMetadata;
  const youtubeMetadataRaw = body?.youtubeMetadata;

  if (typeof baseCaptionRaw !== "string" || !baseCaptionRaw.trim()) {
    return NextResponse.json(
      { error: "baseCaption is required" },
      { status: 400 },
    );
  }
  // 2026-11-01 scale audit (jobs, event size): the caption rides in the publish event
  // and in every step output, so its length is capped before any write.
  const overlongBase = findOverlongCaption({ baseCaption: baseCaptionRaw });
  if (overlongBase) return captionTooLongResponse(overlongBase);

  let perPlatformOverrides: Partial<Record<Platform, string>> | undefined;
  if (overridesRaw != null) {
    // Require a Record<string,string> (review Minor #3 — reject arrays and
    // non-string values so a later publish can't feed a non-string to caption
    // building).
    if (!isValidPerPlatformOverrides(overridesRaw)) {
      return NextResponse.json(
        { error: "perPlatformOverrides must be an object of string values if provided" },
        { status: 400 },
      );
    }
    // 2026-11-01 scale audit (jobs, event size): only platform keys are ever published
    // (`overrides?.[platform]`), so any other key is dropped here - what bounds
    // the event at 1 base + 8 overrides x 10,000 characters - and the cap is
    // checked on what is left.
    perPlatformOverrides = pickPlatformOverrides(overridesRaw);
    const overlongOverride = findOverlongCaption({ perPlatformOverrides });
    if (overlongOverride) return captionTooLongResponse(overlongOverride);
  }

  let youtubeMetadata: YouTubePostMetadata | undefined;
  if (youtubeMetadataRaw != null) {
    if (
      typeof youtubeMetadataRaw !== "object" ||
      !YOUTUBE_PRIVACY_STATUSES.includes(
        youtubeMetadataRaw.privacyStatus as YouTubePostMetadata["privacyStatus"],
      )
    ) {
      return NextResponse.json(
        {
          error:
            "youtubeMetadata.privacyStatus must be one of: public, unlisted, private",
        },
        { status: 400 },
      );
    }
    youtubeMetadata = {
      privacyStatus: youtubeMetadataRaw.privacyStatus as YouTubePostMetadata["privacyStatus"],
    };
  }

  // 2026-11-10: the Google post's button / event / offer. Absent (or null) means
  // none chosen, so the workspace's default button applies at publish time.
  let googleMetadata: GoogleBusinessPostMetadata | undefined;
  if (body?.googleMetadata != null) {
    const parsed = parseGooglePostMetadata(body.googleMetadata);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    googleMetadata = parsed.value;
  }

  // Validate TikTok metadata into a clean typed object (previously forwarded raw
  // — now at parity with youtube, and normalized so it can be persisted on
  // scheduled/draft jobs, review B1). `privacyLevel` must be a STRING if present
  // and is normalized to "" when absent; whether "" is acceptable is decided by
  // the platform-targeting check further down (2026-11-01 audit, ruling R5:
  // TikTok as a target needs an explicit level for EVERY intent, so nothing
  // silently publishes as SELF_ONLY). TikTok's allowed set is per-creator
  // (resolved from creator-info), so it's not a fixed enum here; the toggles
  // coerce to booleans.
  let tiktokMetadata: TikTokPostMetadata | undefined;
  if (tiktokMetadataRaw != null) {
    if (typeof tiktokMetadataRaw !== "object" || Array.isArray(tiktokMetadataRaw)) {
      return NextResponse.json(
        { error: "tiktokMetadata must be an object if provided" },
        { status: 400 },
      );
    }
    const raw = tiktokMetadataRaw as Record<string, unknown>;
    if (raw.privacyLevel !== undefined && typeof raw.privacyLevel !== "string") {
      return NextResponse.json(
        { error: "tiktokMetadata.privacyLevel must be a string" },
        { status: 400 },
      );
    }
    // TikTok guideline 2c: interactions stay off unless the user turned them on,
    // so a missing flag means "disabled", never "allowed".
    const disabledUnlessFalse = (value: unknown) => (value === undefined ? true : Boolean(value));
    tiktokMetadata = {
      privacyLevel: typeof raw.privacyLevel === "string" ? raw.privacyLevel : "",
      disableComment: disabledUnlessFalse(raw.disableComment),
      disableDuet: disabledUnlessFalse(raw.disableDuet),
      disableStitch: disabledUnlessFalse(raw.disableStitch),
      ...(raw.brandedContent !== undefined ? { brandedContent: Boolean(raw.brandedContent) } : {}),
      ...(raw.brandOrganic !== undefined ? { brandOrganic: Boolean(raw.brandOrganic) } : {}),
    };
  }

  // Task 7 — optional per-post platform targeting: a chosen subset of the
  // user's connected platforms to publish to. Absent (`undefined`) means
  // "every connection" (legacy/default behavior) all the way down through
  // the create helpers. SEC-1: only ever a display-safe Platform enum value.
  const VALID_PLATFORMS = new Set<string>(Object.values(Platform));
  let targetPlatforms: Platform[] | undefined;
  if (body?.platforms != null) {
    if (!Array.isArray(body.platforms) || body.platforms.some((p) => typeof p !== "string")) {
      return NextResponse.json(
        { error: "platforms must be an array of platform names" },
        { status: 400 },
      );
    }
    const unknown = body.platforms.filter((p) => !VALID_PLATFORMS.has(p));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unknown platform(s): ${unknown.join(", ")}` },
        { status: 400 },
      );
    }
    const deduped = Array.from(new Set(body.platforms)) as Platform[];
    if (deduped.length === 0) {
      return NextResponse.json({ error: "Select at least one platform." }, { status: 400 });
    }
    targetPlatforms = deduped;
  }

  // 2026-11-10: feed or Story. Read only for a platform the post targets (with
  // no list, every connection is a target). Only a Story is kept: feed is the
  // same as no field, so a feed post creates exactly the job and event it did.
  const readPlacement = (
    platform: StoryPlatform,
    field: StoryPlacementField,
  ): { ok: true; value: { placement: "story" } | undefined } | { ok: false; response: Response } => {
    if (targetPlatforms && !targetPlatforms.includes(platform)) return { ok: true, value: undefined };
    const parsed = parsePlacementMetadata(body[field], field);
    if (!parsed.ok) {
      return { ok: false, response: NextResponse.json({ error: parsed.error }, { status: 400 }) };
    }
    if (parsed.value?.placement !== "story") return { ok: true, value: undefined };
    const refusal = storyMediaRefusal(platform, 1 + (extraMedia?.length ?? 0));
    if (refusal) return { ok: false, response: NextResponse.json({ error: refusal }, { status: 400 }) };
    return { ok: true, value: { placement: "story" } };
  };
  const instagramPlacement = readPlacement("instagram", "instagramMetadata");
  if (!instagramPlacement.ok) return instagramPlacement.response;
  const facebookPlacement = readPlacement("facebook_page", "facebookMetadata");
  if (!facebookPlacement.ok) return facebookPlacement.response;
  const instagramMetadata: InstagramPostMetadata | undefined = instagramPlacement.value;
  const facebookMetadata: FacebookPostMetadata | undefined = facebookPlacement.value;
  const placementArgs = {
    ...(instagramMetadata ? { instagramMetadata } : {}),
    ...(facebookMetadata ? { facebookMetadata } : {}),
  };

  // 2026-11-01 audit (Task 9): an EXPLICIT platform list is checked before any
  // row is written — every requested platform must be able to publish this
  // media (named in the 400 otherwise) and, ruling R5, a TikTok target needs an
  // explicit privacy level whatever the intent. The reuse path has no mimeType
  // here (the stored item is the source of truth), so its media check runs in
  // the create helper and surfaces below as the same PostTargetingError; the
  // TikTok rule needs no media and is applied here for both paths.
  try {
    assertPostTargetsValid(targetPlatforms, mediaFields?.mimeType ?? null, tiktokMetadata);
  } catch (error: unknown) {
    if (error instanceof PostTargetingError) return postTargetingErrorResponse(error);
    throw error;
  }

  const location = typeof locationRaw === "string" && locationRaw.trim() ? locationRaw.trim() : undefined;

  // Roadmap Phase 5 — resolve the intent. `draft: true` wins; otherwise a
  // present `scheduledFor` means "schedule" (validated to be a real, future
  // time); otherwise it's an immediate post (today's path, byte-for-byte).
  let intent: PostJobIntent = "immediate";
  let scheduledForDate: Date | null = null;
  if (body?.draft === true) {
    intent = "draft";
  } else if (body?.scheduledFor != null) {
    const validation = validateScheduledFor(body.scheduledFor, new Date());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    intent = "scheduled";
    scheduledForDate = validation.date;
  }

  // Repeat (brief 11): every time of the series, the first included. Null for
  // a post on its own, which goes down exactly the path it always did.
  let seriesTimes: Date[] | null = null;
  if (body?.repeatAt != null) {
    if (intent !== "scheduled" || !scheduledForDate) {
      return NextResponse.json(
        { error: "A repeating post needs a date and time (scheduledFor). Schedule it, then choose Repeat." },
        { status: 400 },
      );
    }
    if (instagramMetadata || facebookMetadata) {
      return NextResponse.json({ error: REPEAT_STORY_MESSAGE }, { status: 400 });
    }
    const repeats = validateRepeatAt(body.repeatAt, scheduledForDate, new Date());
    if (!repeats.ok) {
      return NextResponse.json({ error: repeats.error }, { status: 400 });
    }
    seriesTimes = [scheduledForDate, ...repeats.dates];
  }

  // Approval workflow (2026-07-26): a MEMBER's post that would publish or
  // schedule is held as a `draft` for an owner to approve. The chosen
  // `scheduledFor` is PRESERVED on the row (re-applied below — the create
  // helpers null it for the draft intent) so approving can honor the member's
  // time (lib/approval.ts approvalOutcome).
  const heldForApproval = shouldHoldForApproval({
    role: context.role,
    requireApproval: context.workspace.requireApproval,
    intent,
  });
  const effectiveIntent: PostJobIntent = heldForApproval ? "draft" : intent;

  // Usage limits (2026-11-10): a post committed to a day counts toward that UTC
  // day's limit. A draft (including one held for approval) is not committed yet.
  if (effectiveIntent !== "draft" && !seriesTimes) {
    const refusal = await checkDailyPostLimit({
      workspaceId: context.workspace.id,
      day: scheduledForDate ?? new Date(),
      mode: effectiveIntent === "scheduled" ? "schedule" : "now",
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }
  }
  // A series: each post counts toward its own UTC day, as if scheduled by hand,
  // and one full day refuses the whole series. The X and YouTube limits count
  // what has published, so each post meets them when it publishes, like any
  // scheduled post.
  if (effectiveIntent !== "draft" && seriesTimes) {
    for (const [index, time] of seriesTimes.entries()) {
      // The stored posts do not include this request's earlier posts on the
      // same UTC day (23 hours apart can share one), so they are added.
      const alsoOnDay = seriesTimes
        .slice(0, index)
        .filter((earlier) => utcDayKey(earlier) === utcDayKey(time)).length;
      const refusal = await checkDailyPostLimit({
        workspaceId: context.workspace.id,
        day: time,
        mode: "schedule",
        alsoOnDay,
      });
      if (refusal) {
        // The limit counts UTC days, so the UTC date is the one that is full.
        const day = time.toLocaleDateString("en-US", {
          timeZone: "UTC",
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });
        return NextResponse.json(
          {
            error: `The post on ${day} (UTC) can't be scheduled. ${refusal.error}`,
            code: refusal.code,
            // The Create page names this instant in the viewer's own zone,
            // with `reason`; `error` is the sentence for other callers.
            date: time.toISOString(),
            reason: refusal.error,
          },
          { status: 429 },
        );
      }
    }
  }

  // Every post of a series is created by the one create-helper call below, in
  // its transaction; a member's series is held there too, each post keeping
  // its own time, so a failure leaves no half-held series.
  const series = seriesTimes
    ? {
        seriesId: randomUUID(),
        times: seriesTimes,
        ...(heldForApproval ? { submittedForApprovalAt: new Date() } : {}),
      }
    : undefined;

  // Publishing needs no verified email (2026-11-09): only the person's own
  // platform accounts, connected through each platform's sign-in, receive it.

  try {
    // Create job records without executing (for background processing).
    // Reuse (mediaItemId, Roadmap Phase 2) skips MediaItem creation via
    // createPostJobForExistingMedia; the original blobUrl path is untouched.
    //
    // Team Workspaces (Task 5): both create helpers take the request's ACTIVE
    // workspace (`context.workspace.id`) explicitly, so a member posting into
    // a shared (non-personal) workspace lands the job there — visible in the
    // shared workspace's activity feed — not in their own personal workspace.
    let postJobId: string;
    let mediaItemId: string;

    if (usingExistingMedia) {
      // assertMediaItemReusable (posting.ts) is workspace-scoped (Task 5): any
      // member of `context.workspace.id` may attach a teammate's media.
      const created = await createPostJobForExistingMedia({
        userId: context.user.id,
        workspaceId: context.workspace.id,
        mediaItemId: body.mediaItemId as string,
        // 07d: absent keeps the reused photo's stored description.
        ...(firstAltText ? { altText: firstAltText } : {}),
        baseCaption: baseCaptionRaw,
        perPlatformOverrides,
        location,
        intent: effectiveIntent,
        scheduledFor: scheduledForDate,
        // Persisted onto the job for scheduled/draft (review B1); ignored for
        // immediate (which carries them in the event below).
        tiktokMetadata,
        youtubeMetadata,
        googleMetadata,
        ...placementArgs,
        // Task 7 — chosen platform subset; undefined = every connection.
        targetPlatforms,
        ...(series ? { series } : {}),
      });
      postJobId = created.postJobId;
      mediaItemId = created.mediaItemId;
    } else {
      // Redundant with the `hasBlobUrl` check above at runtime (this branch
      // only runs when `usingExistingMedia` is false, which — given the
      // earlier guard — guarantees `hasBlobUrl`), but TypeScript can't carry
      // that guarantee through the intermediate boolean, so this narrows
      // `storedBlobUrl` to `string` for the call below.
      if (!storedBlobUrl || !mediaFields) {
        return NextResponse.json(
          { error: "blobUrl is required" },
          { status: 400 },
        );
      }

      const created = await createPostJobOnly({
        userId: context.user.id,
        workspaceId: context.workspace.id,
        media: {
          storageLocation: storedBlobUrl,
          originalFilename: mediaFields.filename,
          mimeType: mediaFields.mimeType,
          sizeBytes: mediaFields.sizeBytes,
          ...(firstAltText ? { altText: firstAltText } : {}),
        },
        ...(extraMedia ? { extraMedia } : {}),
        baseCaption: baseCaptionRaw,
        location,
        perPlatformOverrides,
        intent: effectiveIntent,
        scheduledFor: scheduledForDate,
        // Persisted onto the job for scheduled/draft (review B1); ignored for
        // immediate (which carries them in the event below).
        tiktokMetadata,
        youtubeMetadata,
        googleMetadata,
        ...placementArgs,
        // Task 7 — chosen platform subset; undefined = every connection.
        targetPlatforms,
        ...(series ? { series } : {}),
      });
      postJobId = created.postJobId;
      mediaItemId = created.mediaItemId;
    }

    // Immediate posts trigger the background publish now. Scheduled/draft jobs
    // send NO event here (Roadmap Phase 5): a scheduled job is picked up by the
    // cron due-scanner when `scheduledFor` arrives (which materializes its
    // per-platform results from the connections that exist THEN — the review's
    // run-time-result-creation fix), and a draft is promoted via the publish
    // endpoint. The event shape is identical to the reuse path; the publisher
    // resolves media by id, so it needs no changes.
    // Approval workflow: stamp the submission and restore the member's chosen
    // time. The create helpers write `scheduledFor: null` for a draft intent,
    // so it is re-applied here rather than threading an extra param through
    // both helpers (and their tests).
    if (heldForApproval) {
      // A series was held in its own transaction (above).
      if (!series) {
        await prisma.postJob.update({
          where: { id: postJobId },
          data: {
            submittedForApprovalAt: new Date(),
            ...(scheduledForDate ? { scheduledFor: scheduledForDate } : {}),
          },
        });
      }

      // 2026-11-01 audit: tell the owners something is waiting. Never throws.
      // A series sends this one email, not one per post, and it says so.
      await notifyOwnersOfApprovalRequest({
        workspaceId: context.workspace.id,
        workspaceName: context.workspace.name,
        submitter: context.user,
        caption: baseCaptionRaw,
        // 2026-11-01 audit (M1): the job just snapshotted exactly these
        // overrides and targets (buildPostJobCreateData), so the owners are
        // shown what the publish path will read back. A Story publishes no
        // caption, so its platform reads "Story, no caption" (2026-11-10).
        platformCaptions: withStoryCaptions(
          resolvePlatformCaptions(
            {
              baseCaption: baseCaptionRaw,
              perPlatformOverrides: perPlatformOverrides ?? null,
              publishMetadata: targetPlatforms ? { targetPlatforms } : null,
            },
            null,
          ),
          [
            ...(instagramMetadata ? (["instagram"] as const) : []),
            ...(facebookMetadata ? (["facebook_page"] as const) : []),
          ],
        ),
        ...(series
          ? {
              series: {
                count: series.times.length,
                first: series.times[0],
                last: series.times[series.times.length - 1],
              },
            }
          : {}),
      });
    }

    // A held post sends NO publish event — the owner's approval does that.
    if (effectiveIntent === "immediate") {
      // 2026-11-01 audit: the job and its pending results are already
      // committed — if the event can't be handed to Inngest, fail those
      // results (job → failed) so it can't hang "publishing", and say so.
      try {
        // 2026-11-01 scale audit (jobs H6 + H1): a stable event id (a duplicate
        // send of this job is dropped), the ACTIVE workspace for the shared
        // concurrency key, and `immediate` for the "Post now" priority.
        await inngest.send(
          buildPublishEvent(
            {
              postJobId,
              userId: context.user.id,
              workspaceId: context.workspace.id,
              mediaItemId,
              baseCaption: baseCaptionRaw,
              location,
              perPlatformOverrides: perPlatformOverrides ?? null,
              tiktokMetadata,
              youtubeMetadata,
              googleMetadata,
              ...placementArgs,
            },
            { immediate: true },
          ),
        );
      } catch (dispatchError: unknown) {
        logger.error("[POST /api/posts] Couldn't dispatch the publish event", {
          error: dispatchError,
          postJobId,
          userId: context.user.id,
          workspaceId: context.workspace.id,
        });
        await failPendingPostJobResults(postJobId, DISPATCH_FAILURE);
        return NextResponse.json(
          {
            code: DISPATCH_FAILURE.errorCode,
            error: DISPATCH_FAILURE.errorMessage,
            postJobId,
          },
          { status: 503 },
        );
      }
    }

    // Return immediately - job runs in background
    const postJob = await prisma.postJob.findUnique({
      where: { id: postJobId },
    });
    const results = await prisma.postJobResult.findMany({
      where: { postJobId },
    });

    const message = series
      ? heldForApproval
        ? `Sent for approval: ${series.times.length} posts. An owner will review each one before it publishes.`
        : `${series.times.length} posts scheduled.`
      : heldForApproval
      ? "Sent for approval — an owner will review it before it publishes."
      : intent === "draft"
        ? "Draft saved."
        : intent === "scheduled"
          ? "Post scheduled."
          : "Publishing in progress. Large videos may take a few minutes.";

    // SEC-1 (post-release review Task C): project to the display-safe DTOs —
    // the raw rows carry userId/workspaceId/publishMetadata (job) and
    // socialConnectionId/errorCode (results). `postJob` is `PostJob | null`
    // per findUnique's type; it can't actually be null right after this job
    // was just created, but guard anyway so a theoretical race can't crash
    // toPostJobDetailDto — preserving today's `{ postJob: null, results: [],
    // message }` envelope in that case.
    return NextResponse.json({
      postJob: postJob ? toPostJobDetailDto(postJob) : null,
      results: postJob ? results.map(toPostJobResultSummaryDto) : [],
      message,
      // Approval workflow: lets the composer tell the member their post is
      // queued for review rather than published/scheduled.
      ...(heldForApproval ? { awaitingApproval: true } : {}),
      // Repeat: `postJob` is the first post of the series.
      ...(series ? { series: { id: series.seriesId, count: series.times.length } } : {}),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "NO_CONNECTIONS") {
      return NextResponse.json(
        {
          error: "No connected platforms",
          code: "NO_CONNECTIONS",
          message: "Connect at least one platform before creating a post.",
        },
        { status: 400 },
      );
    }

    // Thrown by the create helpers: the stored media can't go to a requested
    // platform (reuse path), nothing connected can publish this media, or a
    // connected TikTok is implicitly targeted without a privacy level.
    if (error instanceof PostTargetingError) {
      return postTargetingErrorResponse(error);
    }

    if (error instanceof MediaItemUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 404 },
      );
    }

    logger.error("[POST /api/posts] Unexpected error", {
      error,
      usingExistingMedia,
      userId: context.user.id,
      workspaceId: context.workspace.id,
    });
    return NextResponse.json(
      { error: "Failed to create post" },
      { status: 500 },
    );
  }
}
