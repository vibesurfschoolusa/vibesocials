import type {
  Platform,
  PostJobResultStatus,
  PostJobStatus,
} from "@prisma/client";

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
}

/** Response body of `GET /api/posts`. */
export interface PostsResponse {
  jobs: PostJobDTO[];
}
