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
  /** ISO-8601 timestamp of the last successful fetch. */
  fetchedAt: string;
}

/** One platform's outcome for a post job. */
export interface PostJobResultDTO {
  platform: Platform;
  status: PostJobResultStatus;
  /** Provider post id on success (e.g. a YouTube/TikTok id), else null. */
  externalPostId: string | null;
  /** Sanitized, human-readable failure reason, else null. */
  errorMessage: string | null;
  /**
   * Latest engagement snapshot for this result, or null when none has been
   * fetched yet (YouTube-only in v1). Joined by (platform, externalPostId) — the
   * metric's durable identity — so it survives a connection delete.
   */
  metric: PostMetricDTO | null;
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
  results: PostJobResultDTO[];
  /** Attached media for thumbnails (public blob URL — already exposed via /api/media). */
  media: { url: string; mimeType: string } | null;
  /**
   * Compose-time publish choices snapshotted on the job (Roadmap Phase 5 +
   * targeting). Null for legacy/immediate jobs with no snapshot.
   */
  publish: {
    targetPlatforms: Platform[] | null;
    youtubePrivacy: string | null;
    tiktokPrivacy: string | null;
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
}

/** Response body of `GET /api/posts`. */
export interface PostsResponse {
  jobs: PostJobDTO[];
  /**
   * Team Workspaces (Task 4) — total members in the caller's active
   * workspace (from `WorkspaceContext.memberCount`). Gates the `createdBy`
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
 * display-safe caption data callers need) and `updatedAt` (an internal
 * bookkeeping timestamp with no UI use). KEEPS `mediaItemId`: it's not a
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
  mediaItemId: string;
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
