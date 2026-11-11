import type {
  Platform,
  PostJob,
  PostJobResult,
  PostJobResultStatus,
  PostJobStatus,
  Prisma,
  WorkspaceRole,
} from "@prisma/client";

import type { ApprovalState } from "./approval";
import { PUBLISH_UNCONFIRMED_CODE, TIKTOK_PUBLISH_PENDING_CODE } from "./publishOutcomes";
import type { DeferralKind } from "./resultDeferral";

/**
 * Display-safe projection of the PostJob / PostJobResult records surfaced by
 * `GET /api/posts`. Mirrors the SEC-1 DTO discipline: only fields the activity
 * UI renders are included — never accessToken, refreshToken, socialConnection
 * secrets, or the raw metadata JSON. `errorMessage` is sanitized server-side
 * (Phase 2/3) and safe to show.
 *
 * Shared by the API route and the client views so the contract stays in sync.
 */

/**
 * Roadmap Phase 8 (analytics — post performance). Display-safe engagement
 * snapshot for a post. Counts are `null` until the sync cron has fetched them,
 * or when a platform hides a count (e.g. YouTube hidden likes) — the UI renders
 * "—" for `null`, never 0. SEC-1: NEVER includes the raw provider payload,
 * tokens, or the internal metric id — only the numbers the UI shows.
 */
export interface PostMetricDTO {
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** Not exposed by YouTube `videos.list` → always null for YouTube v1. */
  shares: number | null;
  /** LinkedIn and Pinterest only (2026-11-10); null elsewhere. */
  clicks: number | null;
  /** Pinterest only (2026-11-10); null elsewhere. */
  saves: number | null;
  /** ISO-8601 timestamp of the last successful fetch. */
  fetchedAt: string;
}

/**
 * Platforms whose post numbers are stored: YouTube hourly
 * (youtubeMetricsSync.ts), the other four daily (socialMetricsSync.ts).
 */
export const METRIC_PLATFORMS: readonly Platform[] = [
  "youtube",
  "instagram",
  "facebook_page",
  "linkedin",
  "pinterest",
];

/** One platform's outcome for a post job. */
export interface PostJobResultDTO {
  platform: Platform;
  status: PostJobResultStatus;
  /** Provider post id on success (e.g. a YouTube/TikTok id), else null. */
  externalPostId: string | null;
  /** The post's public link when the platform gave one (Instagram), else null. */
  externalPostUrl: string | null;
  /** Sanitized, human-readable failure reason, else null. */
  errorMessage: string | null;
  /**
   * Set only for a `pending` result that is waiting out a platform rate limit or
   * quota (2026-11-01 scale audit, platform limits): why, and the ISO-8601
   * instant the run will try again. `null` otherwise, including for a failed
   * result that still carries an old `deferredUntil`. The stored `errorCode` is
   * an internal classification and is NOT exposed; `kind` is derived from it.
   */
  deferral: { kind: DeferralKind; until: string } | null;
  /**
   * True for a `failed` result whose commit call could not be confirmed
   * (2026-11-01 scale audit, jobs H6): the post may already be live, so the
   * Activity card says so inline, before the Retry button. Derived from the
   * stored `errorCode` (PUBLISH_UNCONFIRMED, or TikTok's TIKTOK_PUBLISH_PENDING,
   * see {@link isUnconfirmedResult}), which is NOT exposed itself.
   */
  unconfirmed: boolean;
  /**
   * Latest engagement snapshot for this result, or null when none has been
   * fetched yet (YouTube-only in v1). Joined by (platform, externalPostId) — the
   * metric's durable identity — so it survives a connection delete.
   */
  metric: PostMetricDTO | null;
}

/**
 * Is this stored result one whose post may already be live
 * ({@link PostJobResultDTO.unconfirmed})? Only a `failed` result counts. Its
 * `errorCode` is PUBLISH_UNCONFIRMED (a commit call whose outcome is unknown) or
 * TikTok's TIKTOK_PUBLISH_PENDING (TikTok has neither confirmed nor denied it).
 * Pure; the code itself never reaches the client (SEC-1).
 */
export function isUnconfirmedResult(result: {
  status: PostJobResultStatus;
  errorCode: string | null;
}): boolean {
  return (
    result.status === "failed" &&
    (result.errorCode === PUBLISH_UNCONFIRMED_CODE || result.errorCode === TIKTOK_PUBLISH_PENDING_CODE)
  );
}

/** A single post job and its per-platform fan-out results. */
export interface PostJobDTO {
  id: string;
  /**
   * `status` is the full Prisma `PostJobStatus` union, so it widens
   * automatically when enum members are added (Roadmap Phase 5:
   * draft/scheduled/cancelled). Consumers that switch on it exhaustively must
   * still be updated — see `JOB_STATUS_META` in post-job-card.tsx.
   */
  status: PostJobStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /**
   * ISO-8601 last-modified timestamp (`PostJob.updatedAt`) — identifies the
   * VERSION of the post being shown (2026-11-01 audit). The Queue sends it
   * back as the approval route's `reviewedUpdatedAt`, so an owner can't
   * approve text that changed after they opened it (409 CHANGED_SINCE_REVIEW).
   */
  updatedAt: string;
  /**
   * ISO-8601 target publish time for a `scheduled` job, else null (Roadmap
   * Phase 5). Drives the Queue ordering + the "Scheduled for …" label.
   */
  scheduledFor: string | null;
  /**
   * Base caption. For scheduled/draft jobs this is the job's own snapshot
   * (`PostJob.baseCaption`); for immediate/older jobs it falls back to the
   * associated media item's caption.
   */
  caption: string | null;
  /**
   * Per-platform caption overrides that REPLACE the base caption on those
   * platforms when the post publishes (2026-11-01 audit, M1). Derived
   * server-side from the same caption source the publish path uses
   * (`resolvePlatformCaptions`), limited to the platforms the job targets, so an
   * approving owner sees exactly the text that will go out — not only the base
   * `caption`. `null` when the post has none. Raw override text (the workspace
   * footer is appended at publish time).
   */
  platformCaptions: Partial<Record<Platform, string>> | null;
  results: PostJobResultDTO[];
  /** Attached media for thumbnails (public blob URL — already exposed via /api/media). */
  media: { url: string; mimeType: string } | null;
  /**
   * How many files the post has (07a): 1 for a single photo or video, 2 to
   * MAX_POST_MEDIA for a post with several photos. `media` is the first. 0 for
   * a post without a file (2026-11-10), whose `media` is null.
   */
  mediaCount: number;
  /**
   * Compose-time publish choices snapshotted on the job (Roadmap Phase 5 +
   * targeting). Null for legacy/immediate jobs with no snapshot.
   */
  publish: {
    targetPlatforms: Platform[] | null;
    youtubePrivacy: string | null;
    tiktokPrivacy: string | null;
    /**
     * 2026-11-10 — the Google post's own options ("update" / "event" / "offer",
     * and a button type such as "BOOK"). Null when the post has none: a post
     * with none gets the workspace's default button at publish time.
     */
    googlePostType: string | null;
    googleButton: string | null;
  } | null;
  /**
   * Team Workspaces (Task 4) — display name of the job's creator, always
   * included by the API. `name` falls back to the email local-part when the
   * user has no display name set; NEVER the full email (SEC-1). `null` only
   * when the creator relation is missing. The UI decides when to render this
   * (design doc §7 — only in workspaces with >1 member; see
   * `PostsResponse.workspaceMemberCount`).
   */
  createdBy: { name: string } | null;
  /**
   * Approval workflow (2026-07-26) — derived from the job's
   * submittedForApprovalAt/approvedAt/status (see lib/approval.ts
   * deriveApprovalState). `"none"` for every post created outside the approval
   * flow, so existing UI is unaffected; the Queue renders the
   * awaiting-approval section from `"pending"`.
   */
  approvalState: ApprovalState;
  /**
   * Client review link (2026-11-10) — the client's own say through the
   * workspace's /v/ link, separate from `approvalState`. ISO-8601 when the
   * client approved this post (it stays scheduled), or asked for a change (it
   * is then a draft, with `clientNote` the client's plain text). Null otherwise.
   * GET /api/posts always sends all three; they are optional only so DTOs built
   * elsewhere (test fixtures) need not name them.
   */
  clientApprovedAt?: string | null;
  clientChangeRequestedAt?: string | null;
  clientNote?: string | null;
  /**
   * 2026-11-10 — the platforms this job sent as a Story, from its stored
   * `publishMetadata` (lib/storyPlacement.ts storyPlatformsOf); empty for a job
   * without one. Optional so other builders of this DTO need not set it.
   */
  storyPlatforms?: Platform[];
  /**
   * Repeat (brief 11) — the series this post was created in, or null for a post
   * created on its own. For a post in a series, its place by time and the
   * number of the series' posts that still exist ("Repeats: 3 of 8"). Optional
   * so other builders of this DTO need not set them.
   */
  seriesId?: string | null;
  seriesPosition?: number;
  seriesCount?: number;
}

/**
 * Each post's place in its series and the series' size, from every existing
 * post of the series on the page: ordered by time (a post without one last),
 * then id. Posts without a series are left out, and so are cancelled ones, so
 * the rest of a series reads "1 of 2" once its later posts are cancelled;
 * published posts still count.
 */
export function seriesPlaces(
  rows: readonly { id: string; seriesId: string | null; scheduledFor: Date | null; status?: string }[],
): Map<string, { position: number; count: number }> {
  const bySeries = new Map<string, { id: string; at: number }[]>();
  for (const row of rows) {
    if (!row.seriesId || row.status === "cancelled") continue;
    const list = bySeries.get(row.seriesId) ?? [];
    list.push({ id: row.id, at: row.scheduledFor?.getTime() ?? Number.POSITIVE_INFINITY });
    bySeries.set(row.seriesId, list);
  }
  const places = new Map<string, { position: number; count: number }>();
  for (const list of bySeries.values()) {
    list.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at));
    list.forEach((entry, index) => places.set(entry.id, { position: index + 1, count: list.length }));
  }
  return places;
}

/** Response body of `GET /api/posts`. */
export interface PostsResponse {
  jobs: PostJobDTO[];
  /**
   * The caller's active workspace, which these jobs belong to. The Queue's
   * client review link panel sends it back, so a workspace switch in another
   * tab answers 409 instead of acting on a workspace this page does not show.
   */
  workspaceId: string;
  /**
   * Team Workspaces (Task 4) — total members in the caller's active
   * workspace (from `getWorkspaceMemberCount`). Gates the `createdBy`
   * attribution display: the UI only shows "by {name}" when this is >1
   * (design doc §7), so a solo workspace's activity feed looks unchanged.
   */
  workspaceMemberCount: number;
  /**
   * Approval workflow — the CALLER's role in the active workspace, so the Queue
   * knows whether to render Approve/Reject controls (owners) or a read-only
   * "waiting for approval" badge (members).
   */
  workspaceRole: WorkspaceRole;
  /**
   * Approval workflow — does the active workspace require owner approval for
   * members' posts? With `workspaceRole` this tells the Queue what a member's
   * "publish" / edit will actually do (submit for approval vs. go out).
   */
  workspaceRequireApproval: boolean;
  /**
   * Keyset pagination cursor for the NEXT (older) page (activity pagination).
   * An opaque base64url token encoding the last returned job's (createdAt, id)
   * total-order key; pass it back as `?cursor=` to fetch the following page.
   * `null` when this is the last page. Additive — page-1 callers that ignore it
   * are unaffected, and the field is always present (never omitted).
   */
  nextCursor: string | null;
}

/**
 * Display-safe single-job projection for `GET /api/posts/[postJobId]` and the
 * `POST /api/posts` create echo (post-release review Task C, SEC-1).
 *
 * DROPS `userId`, `workspaceId` (ownership/tenancy — the route already scopes
 * the read to the caller's workspace before this ever runs), `publishMetadata`
 * (the raw compose-time snapshot — `perPlatformOverrides` below is the
 * display-safe caption data callers need) and `updatedAt` (no caller of THIS
 * single-job DTO needs it; the Queue's approval review reads it from the
 * list DTO, {@link PostJobDTO.updatedAt}). KEEPS `mediaItemId`: it's not a
 * secret — it's the same id already returned by `GET /api/media` /
 * `POST /api/media`, and the compose UI uses it as a public "reuse this
 * media" handle (`/posts/new?mediaItemId=`).
 */
export interface PostJobDetailDTO {
  id: string;
  status: PostJobStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 target publish time for a `scheduled` job, else null. */
  scheduledFor: string | null;
  baseCaption: string | null;
  perPlatformOverrides: Prisma.JsonValue | null;
  /** Null for a post without a file (2026-11-10). */
  mediaItemId: string | null;
}

/**
 * Display-safe projection of one platform's outcome for `GET
 * /api/posts/[postJobId]` and the `POST /api/posts` create echo (post-release
 * review Task C, SEC-1).
 *
 * DROPS `id` and `postJobId` (internal row/foreign-key ids the client never
 * addresses directly — the job itself is already keyed by `PostJobDetailDTO.id`),
 * `socialConnectionId` (an internal FK into the caller's OAuth connection —
 * never surfaced, unlike the public `mediaItemId` above), `errorCode` (an
 * internal classification; `errorMessage` is the sanitized, human-readable
 * string the UI actually renders) and `createdAt`/`updatedAt` (no UI use for a
 * per-result timestamp).
 */
export interface PostJobResultSummaryDTO {
  platform: Platform;
  status: PostJobResultStatus;
  /** Provider post id on success (e.g. a YouTube/TikTok id), else null. */
  externalPostId: string | null;
  /** Sanitized, human-readable failure reason, else null. */
  errorMessage: string | null;
}

/** Map a PostJob row to its display-safe single-job DTO. */
export function toPostJobDetailDto(job: PostJob): PostJobDetailDTO {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    scheduledFor: job.scheduledFor?.toISOString() ?? null,
    baseCaption: job.baseCaption,
    perPlatformOverrides: job.perPlatformOverrides,
    mediaItemId: job.mediaItemId,
  };
}

/** Map a PostJobResult row to its display-safe summary DTO. */
export function toPostJobResultSummaryDto(result: PostJobResult): PostJobResultSummaryDTO {
  return {
    platform: result.platform,
    status: result.status,
    externalPostId: result.externalPostId,
    errorMessage: result.errorMessage,
  };
}

/**
 * Keyset pagination cursor helpers for `GET /api/posts` (activity pagination).
 * They are generic over any `(createdAt, id)` total order, so `GET /api/media`
 * reuses them as-is (2026-11-01 scale audit (W11)).
 *
 * The cursor is an opaque, URL-safe token over the (createdAt, id) total-order
 * key the endpoint pages by (`orderBy: [{ createdAt: "desc" }, { id: "desc" }]`).
 * It carries no secret or tenant data — just a job id + its creation timestamp,
 * both already in the DTO — so it round-trips safely through the client as a
 * bare `?cursor=` query param. Server-only in practice (only the route imports
 * these functions as values; client modules import this file for TYPES only,
 * which are erased at build), so the Node `Buffer` global is always available.
 */
export function encodePostsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

/**
 * Inverse of {@link encodePostsCursor}. Returns `null` for ANY malformed input
 * — undecodable base64, a missing `|` separator, an empty id, or an unparseable
 * timestamp — so the route can answer a tampered/garbage `?cursor=` with a 400
 * and never feed a bad value into the keyset query. Splits on the FIRST `|`
 * only: an ISO-8601 timestamp never contains one, so everything after it is the
 * id (preserved verbatim even in the degenerate case that an id did contain a
 * `|`).
 */
export function decodePostsCursor(cursor: string): { createdAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) {
    return null;
  }

  const isoPart = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!id) {
    return null;
  }

  const createdAt = new Date(isoPart);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id };
}
