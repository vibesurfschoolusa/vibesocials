import type { Prisma, SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_CODE, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS, TIKTOK_DEFAULT_CAPTION } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";

import { commitRequest, publishUnconfirmedError } from "./commitCall";
import {
  connectionTokenChangedError,
  flagRejectedToken,
  flagTerminalRefreshFailure,
  isTerminalRefreshFailure,
  type TokenSnapshot,
} from "./connectionHealth";
import { refreshConnectionToken } from "./connectionRefresh";
import {
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  openBlobChunkStream,
  usesLargeUploadPath,
  type BlobChunkStream,
} from "./largeUpload";
import {
  budgetedTimeout,
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  remainingMs,
} from "./publishBudget";
import { classifyRateLimit, isRateLimitedError } from "./rateLimited";
import type { PlatformClient, PublishContext, PublishResult, TikTokCreatorInfo } from "./types";

/** Minimal shape of TikTok's creator_info response (only the fields we read). */
interface TikTokCreatorInfoResponse {
  data?: {
    creator_username?: string;
    creator_avatar_url?: string;
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  };
}

/** post_info payload sent to TikTok's video/init endpoint. */
interface TikTokPostInfo {
  title: string;
  privacy_level: string;
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
  video_cover_timestamp_ms: number;
  disclosure_settings?: { disclosure_type: string };
  brand_organic_type?: string;
  brand_content_type?: string;
}

/** Minimal shape of TikTok's video/init response (only the fields we read). */
interface TikTokInitResponse {
  data?: { publish_id?: string; upload_url?: string };
  error?: { code?: string };
}

/** Minimal shape of TikTok's publish/status/fetch response (only the fields we read). */
interface TikTokStatusResponse {
  data?: { status?: string; fail_reason?: string };
}

/**
 * Shape of TikTok's /v2/oauth/token/ response (refresh_token grant). A failure
 * carries `error` / `error_description` / `log_id` instead of the token fields.
 * See https://developers.tiktok.com/doc/oauth-user-access-token-management
 */
interface TikTokRefreshResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  log_id?: string;
}

const TIKTOK_API_BASE = "https://open.tiktokapis.com";
const TIKTOK_TOKEN_ENDPOINT = `${TIKTOK_API_BASE}/v2/oauth/token/`;

/**
 * Code thrown (and recorded via flagRejectedToken / flagTerminalRefreshFailure) whenever TikTok
 * tells us the connection's credentials are dead: a 401 from any API call
 * during publish, or a terminal refresh failure. Follows the
 * `*_RECONNECT_REQUIRED` convention (see connectionHealth.ts).
 */
const TIKTOK_RECONNECT_CODE = "TIKTOK_RECONNECT_REQUIRED";

/** Treat tokens within 5 minutes of expiry as expired (matches linkedinClient.ts). */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** TikTok access tokens last ~24h; fallback when `expires_in` is missing/non-finite. */
const TIKTOK_DEFAULT_TOKEN_TTL_SECONDS = 86_400;

/**
 * Publish-status poll budget: 24 attempts x 5s = ~120s. TikTok commonly needs
 * well over the old 10 x 3s = 30s to pull/process an upload. With a step
 * deadline the poll also stops early (see the step budget below).
 */
export const TIKTOK_POLL_MAX_ATTEMPTS = 24;
export const TIKTOK_POLL_INTERVAL_MS = 5_000;

/** Per-request timeouts (each further clamped to the step's time left). */
const TIKTOK_STATUS_TIMEOUT_MS = 30_000;
const TIKTOK_INIT_TIMEOUT_MS = 30_000;
const TIKTOK_DOWNLOAD_TIMEOUT_MS = 120_000;
const TIKTOK_CHUNK_UPLOAD_TIMEOUT_MS = 120_000;

/*
 * STEP BUDGET (2026-11-01 audit, Task 4 item 10). One TikTok step must end
 * well inside Vercel's 300s per-invocation cap. publishToPlatform stamps a
 * deadline PUBLISH_STEP_BUDGET_MS = 225s after the step starts
 * (publishBudget.ts) and passes it as ctx.deadline; the worst case per phase:
 *
 *   token refresh       <= min(30s, time left); first thing an attempt does, and a retry only
 *                       starts with >= 60s left (MIN_RETRY_WINDOW_MS) — and
 *                       reuses the refreshed token, so it does not refresh again
 *   creator_info, init  each <= min(30s, time left)
 *   download            <= min(120s, time left), whole transfer
 *   chunk PUTs          each <= min(120s, time left)
 *   status poll         nominally 24 x (5s wait + <= 30s check); a wait + check
 *                       is only started if >= 5s + 5s remain, and the check is
 *                       clamped to the time left -> ends by the deadline with
 *                       TIKTOK_PUBLISH_PENDING ("check TikTok before retrying")
 *   in-step retries     2s / 8s backoff, only with >= 60s left; the retried
 *                       attempt is clamped to the same deadline. The poll phase
 *                       only ever throws NON-transient errors (it absorbs 429/
 *                       5xx/network itself), so a retry never restarts a publish
 *                       TikTok may already be processing.
 *   no request starts with < 5s left (PUBLISH_TIME_BUDGET_EXCEEDED: nothing sent)
 *
 * => all TikTok I/O ends by the deadline (225s): every phase that can start
 *    late is clamped to it. After it only the PostJobResult write runs (ms),
 *    so the step ends < 240s. Small JSON bodies are read after their headers
 *    and are not separately timed (same as every client).
 * Before: 24 x (5s + up to 30s) = 840s of polling alone, x3 attempts.
 *
 * STREAMED UPLOAD (2026-11-02 scale audit, jobs B3; publishStreamed below). The same
 * deadline bounds every request, and a chunk is only started when it can finish:
 *
 *   first step      token refresh, creator_info, video/init: each <= min(30s, time left)
 *   blob read       one GET per step, aborted at the deadline; a read that runs into it
 *                   pauses (nothing was sent)
 *   chunk PUT       <= min(120s, time left); a chunk that is not the last starts with
 *                   >= 60s left (LARGE_UPLOAD_CHUNK_WINDOW_MS), and a failure or timeout
 *                   at the deadline pauses instead of failing
 *   final chunk     starts with >= 150s left (TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS): its PUT
 *                   (<= 120s) and the status poll (the rest) end by the deadline, in the
 *                   same step, so the commit and what follows it never cross a step
 *   pause           one small state write, after the deadline
 */

/** Max bytes per TikTok FILE_UPLOAD chunk (TikTok allows 5MB to 64MB; we use 10MB). */
export const TIKTOK_MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * TikTok's hard cap on the FINAL (merged) chunk. With a 10MB base chunk the
 * final chunk is always under 20MB, so this is only a sanity bound.
 */
export const TIKTOK_MAX_FINAL_CHUNK_SIZE = 128 * 1024 * 1024; // 128MB

/** A half-open byte range [start, end) for one uploaded chunk. */
export interface ChunkRange {
  /** Inclusive start byte offset. */
  start: number;
  /** Exclusive end byte offset (the last byte sent is end - 1). */
  end: number;
}

export interface ChunkPlan {
  /** Value sent as source_info.chunk_size. */
  chunkSize: number;
  /** Value sent as source_info.total_chunk_count (TikTok's floor rule). */
  totalChunks: number;
  /** Contiguous byte ranges to PUT; ranges.length === totalChunks. */
  ranges: ChunkRange[];
}

/**
 * Compute the TikTok FILE_UPLOAD chunk plan for a video of `size` bytes.
 *
 * TikTok's contract: chunk_size is capped (10MB here), total_chunk_count is
 * floor(size / chunk_size), every chunk except the last is exactly chunk_size
 * bytes, and the FINAL chunk absorbs the trailing size % chunk_size bytes (so
 * it may be up to nearly 2x chunk_size, but never above TikTok's 128MB
 * final-chunk cap for chunk sizes at or below 64MB). A file at or below
 * chunk_size uploads as a single whole-file chunk.
 *
 * This is the fix for the trailing-byte data loss: the final range ends at
 * `size`, not `start + chunkSize`.
 */
export function computeChunkPlan(
  size: number,
  maxChunkSize: number = TIKTOK_MAX_CHUNK_SIZE,
): ChunkPlan {
  const chunkSize = Math.min(size, maxChunkSize);
  const totalChunks = size <= maxChunkSize ? 1 : Math.floor(size / chunkSize);

  const ranges: ChunkRange[] = [];
  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkSize;
    // The final chunk extends to `size`, absorbing any trailing bytes that a
    // fixed `start + chunkSize` cap would otherwise drop.
    const end = index === totalChunks - 1 ? size : start + chunkSize;
    ranges.push({ start, end });
  }

  return { chunkSize, totalChunks, ranges };
}

// 2026-11-02 scale audit (jobs B3): a video above LARGE_VIDEO_THRESHOLD_BYTES
// (largeUpload.ts) on a platform listed in LARGE_UPLOAD_PLATFORMS is read from
// storage one chunk at a time and PUT to TikTok's `upload_url` across several
// steps, instead of being downloaded whole. Source of every protocol fact below:
// https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
//
//   chunks   PUT <upload_url> with `Content-Type`, `Content-Length` and
//            `Content-Range: bytes FIRST-LAST/TOTAL`. "File chunks must be uploaded
//            sequentially." The plan is computeChunkPlan's: 10 MiB chunks, the last
//            one absorbing the remainder, 1 to 1,000 of them (a 512 MB video is 51).
//   answers  206: more chunks remain. 201: "all parts uploaded", TikTok starts posting.
//            403: the upload_url expired. 404: there is no upload task. 416: the range
//            does not match TikTok's progress, and the answer carries
//            `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}`. 5xx: "retry submitting
//            this chunk".
//   expiry   "The upload_url is valid for one hour after issuance", and `video/init` is
//            limited to 6 requests a minute per user token:
//            https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
//
// The `upload_url` is a capability URL (whoever holds it can write the upload), so it is
// saved only sealed (uploadState.ts) and never logged. creator_info and video/init run
// once, in the first step; later steps skip both and resume from the saved state.

/** The `kind` of the upload state a streamed TikTok upload saves and loads (uploadState.ts). */
export const TIKTOK_UPLOAD_STATE_KIND = "tiktok_file_upload";

/**
 * How long an `upload_url` is valid: "one hour after issuance"
 * (https://developers.tiktok.com/doc/content-posting-api-reference-direct-post).
 */
export const TIKTOK_UPLOAD_URL_TTL_MS = 3_600_000;

/**
 * A chunk is not sent to an `upload_url` with less than this left of its hour (10 min):
 * the upload starts over on a new one instead, as long as the final chunk has not been
 * sent. A slower upload would die on a 403 part-way through the chunk.
 */
export const TIKTOK_UPLOAD_URL_SAFETY_MS = 600_000;

/**
 * The final chunk is the commit call, and TikTok's status poll runs after it in the
 * same step, so it starts only with this much of the step left (150 s): one chunk
 * request (up to 120 s) and a poll that still has time to see the post through.
 * Post-commit work never crosses a step boundary.
 */
export const TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS = 150_000;

/**
 * Times one step may start a new upload because the URL expired (by the clock or by a
 * 403). A new URL that is refused too is a failure, not a reason to start over forever.
 */
const TIKTOK_MAX_RENEWALS_PER_STEP = 1;

/** What a step saves as readable progress. No URL may be in it (uploadState.ts). */
interface TikTokUploadData {
  publishId: string;
  /** Epoch ms just before `video/init` was sent: the upload_url is valid for an hour from after it. */
  initAt: number;
  size: number;
  chunkSize: number;
  totalChunks: number;
  /** Index of the next chunk to send. */
  nextChunk: number;
}

/** What a step saves sealed: the upload_url is a capability URL. */
interface TikTokUploadSecret {
  uploadUrl: string;
}

/** An upload that has been started on TikTok: where it is and which URL carries it. */
interface TikTokUploadSession {
  publishId: string;
  uploadUrl: string;
  initAt: number;
  nextChunk: number;
}

/** The upload_url is sent the video, so it must be an https URL. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The saved upload, if it is one this step can resume: the same video and plan, a
 * sealed https `upload_url`, a publish id, and a position inside the plan. Anything else
 * (another size, a missing secret, a hand-edited row) is treated as no state at all, and
 * the step starts a new upload.
 */
function readSavedUpload(
  saved: UploadSnapshot<TikTokUploadData, TikTokUploadSecret> | null,
  plan: ChunkPlan | null,
  size: number,
): TikTokUploadSession | null {
  if (saved === null || plan === null) return null;
  const { data, secret } = saved;
  const uploadUrl = secret?.uploadUrl;
  if (typeof uploadUrl !== "string" || !isHttpsUrl(uploadUrl)) return null;
  if (typeof data?.publishId !== "string" || data.publishId === "") return null;
  if (typeof data.initAt !== "number" || !Number.isFinite(data.initAt)) return null;
  if (data.size !== size || data.chunkSize !== plan.chunkSize || data.totalChunks !== plan.totalChunks) {
    return null;
  }
  if (!Number.isInteger(data.nextChunk) || data.nextChunk < 0 || data.nextChunk >= plan.totalChunks) {
    return null;
  }
  return { publishId: data.publishId, uploadUrl, initAt: data.initAt, nextChunk: data.nextChunk };
}

function tiktokUploadError(message: string, status?: number): Error & { code: string; status?: number } {
  const error = new Error(message) as Error & { code: string; status?: number };
  error.code = "TIKTOK_UPLOAD_FAILED";
  if (status !== undefined) error.status = status;
  return error;
}

/**
 * Did a chunk request fail in a way that says nothing about the upload: a 5xx, a
 * timeout, a dropped or refused connection, or no time left to send it? The same chunk
 * can simply be sent again in the next step. A 4xx, a rate limit or an error we do not
 * recognize is not this: it says something definite.
 */
function isTransientChunkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return (
    code === FETCH_TIMEOUT_CODE ||
    code === PUBLISH_BUDGET_EXCEEDED_CODE ||
    (typeof status === "number" && status >= 500)
  );
}

/**
 * Where a 416 says TikTok's upload stands, as a chunk index; null when it cannot be
 * trusted. The answer carries `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}`; whether
 * UPLOADED_BYTES is a count or the index of the last byte is not documented, so either
 * reading is accepted, but only when it lands on the start of a chunk of the plan (the two
 * readings are a byte apart and chunk starts are 10 MiB apart, so at most one can). The
 * total must be this video's.
 */
function resyncedChunk(response: Response, plan: ChunkPlan, size: number): number | null {
  const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get("Content-Range")?.trim() ?? "");
  if (!match || Number(match[2]) !== size) return null;
  const reported = Number(match[1]);
  for (const nextByte of [reported, reported + 1]) {
    const index = plan.ranges.findIndex((range) => range.start === nextByte);
    if (index !== -1) return index;
  }
  return null;
}

/**
 * Compute the TikTok post title/caption the same way `publishVideo` does:
 * fall back to a default when `caption` is empty, else truncate to TikTok's
 * client-enforced limit — read from the shared `platformLimits.ts` map
 * instead of an inline literal. Extracted as a pure, exported function so
 * this behavior can be asserted directly in tests without mocking the
 * chunked-upload/network calls the rest of `publishVideo` makes — see
 * tiktokClient.test.ts.
 */
export function computeTikTokCaption(caption: string): string {
  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.tiktok;

  if (!caption) {
    return TIKTOK_DEFAULT_CAPTION;
  }

  // tiktok's charLimit is always a number (see platformLimits.ts); the null
  // check only exists to satisfy the shared `Record<Platform, ...>` type.
  return charLimit === null ? caption : truncateGraphemes(caption, charLimit, { ellipsis });
}

/** Terminal/transient classification of a single TikTok publish-status poll. */
export type PollOutcome = "complete" | "failed" | "pending";

/**
 * Pure decision for one publish-status poll result.
 *
 * TikTok's /v2/post/publish/status/fetch/ returns UPPERCASE statuses
 * (PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE,
 * FAILED), so the value is normalized (trim + case-insensitive) before
 * comparing. PUBLISH_COMPLETE and SEND_TO_USER_INBOX are success; FAILED is
 * terminal; every other status (processing, unknown, or missing) is still
 * pending, so the caller should keep polling.
 */
export function decidePollOutcome(status: string | null | undefined): PollOutcome {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (normalized === "PUBLISH_COMPLETE" || normalized === "SEND_TO_USER_INBOX") {
    return "complete";
  }
  if (normalized === "FAILED") return "failed";
  return "pending";
}

function tiktokReconnectRequiredError(): Error & { code: string } {
  const error = new Error(
    "Your TikTok connection has expired — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = TIKTOK_RECONNECT_CODE;
  return error;
}

/**
 * Flag the connection after TikTok rejected the access token (401), guarded by
 * the tokens that call used (2026-11-02 scale audit, jobs, token refresh):
 * another process may have refreshed them (TikTok rotates the refresh token) or
 * the user may have reconnected since this publish read its row. Flag fields
 * only - never touches accessToken/refreshToken (see connectionHealth.ts).
 * Returns "superseded" when the stored tokens differ and nothing was written.
 */
async function flagTikTokRejection(
  connection: TokenSnapshot,
  where: string,
): Promise<"flagged" | "superseded" | "error"> {
  console.error("[TikTok] Access token rejected; marking connection for reconnect", {
    connectionId: connection.id,
    where,
  });
  return flagRejectedToken(connection, TIKTOK_RECONNECT_CODE);
}

/**
 * TikTok rejected the access token (401) BEFORE anything was committed. Flag the
 * connection so the user sees "reconnect" copy, then throw the reconnect code; or,
 * when the stored tokens changed since this call read them, flag nothing and
 * throw the plain, retryable CONNECTION_TOKEN_CHANGED.
 */
async function throwTikTokReconnect(connection: TokenSnapshot, where: string): Promise<never> {
  if ((await flagTikTokRejection(connection, where)) === "superseded") {
    throw connectionTokenChangedError();
  }
  throw tiktokReconnectRequiredError();
}

function isExpiredOrExpiringSoon(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded -> cannot judge; let publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Refresh a TikTok access token using the stored refresh token and persist the
 * result. Also exposed as `tiktokClient.refreshToken`, which is what the daily
 * connection-health sweep calls.
 *
 * Request/response per
 * https://developers.tiktok.com/doc/oauth-user-access-token-management :
 * POST /v2/oauth/token/ (x-www-form-urlencoded: client_key, client_secret,
 * grant_type=refresh_token, refresh_token) -> access_token, expires_in,
 * refresh_token, refresh_expires_in, ...
 *
 * UNLIKE Google/LinkedIn ("never write refreshToken"), TikTok documents that
 * the returned refresh_token "may be different than the one passed" and that a
 * changed one MUST replace the stored one — so a changed refresh token IS
 * persisted (alongside the access token + expiry, in the same write). An
 * absent or unchanged one leaves the stored value untouched.
 *
 * Failure handling (flag fields are written ONLY by markConnectionNeedsReconnect,
 * never in the same update as tokens):
 *  - terminal (the shared isTerminalRefreshFailure rule in connectionHealth.ts,
 *    also used by the Google/LinkedIn refreshes) / no refresh token stored:
 *    flag needsReconnect, throw `TIKTOK_RECONNECT_REQUIRED`. The flag is guarded
 *    by the tokens this refresh sent (2026-11-01 scale audit, jobs, token
 *    refresh): TikTok rotates the refresh token, so a refresh that lost a race
 *    gets `invalid_grant` for a token the winner already replaced. If the stored
 *    tokens changed, NOTHING is flagged and `TOKEN_REFRESH_SUPERSEDED` is thrown
 *    instead (refreshConnectionToken then returns the stored row).
 *  - this function takes no lock: call it through refreshConnectionToken
 *    (connectionRefresh.ts), as ensureFreshTikTokToken and the health sweep do.
 *  - 429 / 5xx / other non-terminal responses: throw `TIKTOK_TOKEN_REFRESH_FAILED`
 *    (sanitized, carries `status` so withTransientRetries can retry 429/5xx)
 *    WITHOUT flagging. Network errors propagate unchanged (retried in-step only
 *    when they prove the connection was never made — see transientRetry.ts).
 *  - missing env credentials: throw `TIKTOK_MISSING_OAUTH_CREDENTIALS` without
 *    flagging (deployment problem, not a per-connection one).
 *
 * `opts.deadline` (epoch ms, publishBudget.ts; 2026-11-01 scale audit, step
 * budget, Task 7): the token request timeout is clamped to the time left, and
 * with under 5 s left it throws `PUBLISH_TIME_BUDGET_EXCEEDED` BEFORE any request
 * or write (and never flags the connection). Without a deadline the request
 * keeps its 30 s default.
 */
export async function refreshTikTokToken(
  connection: SocialConnection,
  opts?: { deadline?: number },
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    console.warn("[TikTok] No refresh token available; marking connection for reconnect", {
      connectionId: connection.id,
    });
    await flagTerminalRefreshFailure(connection, TIKTOK_RECONNECT_CODE);
    throw tiktokReconnectRequiredError();
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    console.error("[TikTok] Missing TikTok OAuth credentials", {
      connectionId: connection.id,
      code: "TIKTOK_MISSING_OAUTH_CREDENTIALS",
    });
    const error = new Error("Missing TikTok OAuth credentials") as Error & { code: string };
    error.code = "TIKTOK_MISSING_OAUTH_CREDENTIALS";
    throw error;
  }

  // Throws (before anything is sent) when the step budget is spent.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, opts?.deadline);

  console.log("[TikTok] Refreshing access token", { connectionId: connection.id });

  const response = await fetchWithTimeout(
    TIKTOK_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    timeoutMs,
  );

  // Parse defensively: a proxy/5xx page is not JSON, and TikTok can report an
  // OAuth error in the body of an HTTP 200.
  const rawBody = await response.text().catch(() => "");
  let tokenData: TikTokRefreshResponse | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object") tokenData = parsed as TikTokRefreshResponse;
  } catch {
    tokenData = null;
  }

  if (!response.ok || !tokenData?.access_token) {
    const oauthError = typeof tokenData?.error === "string" ? tokenData.error : undefined;
    // Server-side diagnostics only: status + TikTok's error identifiers. Never
    // the request (secrets/tokens), and never surfaced to the user.
    console.error("[TikTok] Token refresh failed", {
      connectionId: connection.id,
      status: response.status,
      error: oauthError,
      errorDescription: tokenData?.error_description,
      logId: tokenData?.log_id,
    });

    if (isTerminalRefreshFailure(response.status, oauthError)) {
      await flagTerminalRefreshFailure(connection, TIKTOK_RECONNECT_CODE);
      throw tiktokReconnectRequiredError();
    }

    const error = new Error(
      `Failed to refresh TikTok access token (status ${response.status})`,
    ) as Error & { code: string; status: number };
    error.code = "TIKTOK_TOKEN_REFRESH_FAILED";
    error.status = response.status;
    throw error;
  }

  // Guard: fall back to TikTok's standard ~24h access-token TTL if expires_in
  // is missing/non-finite, rather than persisting an Invalid Date.
  const expiresInSeconds =
    typeof tokenData.expires_in === "number" &&
    Number.isFinite(tokenData.expires_in) &&
    tokenData.expires_in > 0
      ? tokenData.expires_in
      : TIKTOK_DEFAULT_TOKEN_TTL_SECONDS;

  // A successful refresh means the connection works again, so clear any stale
  // reconnect-health flags (never SET them here — that is only ever a
  // flag-only write via markConnectionNeedsReconnect).
  const data: Prisma.SocialConnectionUpdateInput = {
    accessToken: tokenData.access_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
  };
  // TikTok may rotate the refresh token; a different one must replace the old.
  if (
    typeof tokenData.refresh_token === "string" &&
    tokenData.refresh_token.length > 0 &&
    tokenData.refresh_token !== refreshToken
  ) {
    data.refreshToken = tokenData.refresh_token;
  }

  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data,
  });

  console.log("[TikTok] Access token refreshed successfully", {
    connectionId: connection.id,
    refreshTokenRotated: data.refreshToken !== undefined,
  });

  return updated;
}

/**
 * Ensure the connection's access token is usable before publishing: refresh it
 * when `expiresAt` is within 5 minutes of now (or past). A null `expiresAt`
 * cannot be judged, so the connection is returned unchanged. Failures
 * propagate as thrown by refreshTikTokToken (terminal -> flagged reconnect
 * error; transient -> unflagged, retryable). Returns the (possibly refreshed)
 * connection. `deadline` (epoch ms) bounds the refresh request (see
 * {@link refreshTikTokToken}).
 *
 * 2026-11-01 scale audit (jobs, token refresh): the refresh runs under the
 * per-connection lock (refreshConnectionToken), so two publishes, or a publish
 * and the health sweep, never spend the same rotating refresh token twice; the
 * loser gets the winner's row. Exported for unit tests.
 */
export async function ensureFreshTikTokToken(
  connection: SocialConnection,
  deadline?: number,
): Promise<SocialConnection> {
  if (!isExpiredOrExpiringSoon(connection.expiresAt)) {
    return connection;
  }
  return refreshConnectionToken(
    connection,
    (current) => refreshTikTokToken(current, { deadline }),
    { deadline },
  );
}

/** TikTok's `fail_reason` values are snake_case enums; anything else is not echoed. */
function sanitizeFailReason(reason: unknown): string | null {
  return typeof reason === "string" && /^[a-z0-9_]{1,64}$/i.test(reason) ? reason : null;
}

export interface PollTikTokPublishStatusOptions {
  accessToken: string;
  publishId: string;
  /**
   * The connection and the tokens this poll sends. Used to flag it, guarded by
   * those tokens, if TikTok answers 401 mid-poll.
   */
  connection: TokenSnapshot;
  /** Test seam: defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  intervalMs?: number;
  /** The step's deadline (epoch ms): never start a wait + check that cannot end before it. */
  deadline?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Poll TikTok's publish status until the post is confirmed. Resolves ONLY on a
 * complete outcome; every other outcome throws so the job records a failure:
 *  - FAILED -> `TIKTOK_PUBLISH_FAILED` (with TikTok's `fail_reason` when present)
 *  - 401 -> `PUBLISH_UNCONFIRMED` (connection flagged when its tokens are
 *    unchanged). The poll runs after the final chunk was committed and TikTok may
 *    be posting, so a reconnect-and-retry there could double-post.
 *  - budget exhausted (24 x 5s = ~120s, or the step `deadline` is near) ->
 *    `TIKTOK_PUBLISH_PENDING`: TikTok has not confirmed or denied the post, so
 *    it may still appear on the account.
 * Transient fetch/parse/HTTP errors within a single iteration are logged and
 * retried on the next one; they must NOT be mistaken for a terminal outcome —
 * and never escape, so withTransientRetries can never restart a publish TikTok
 * may already be processing.
 */
export async function pollTikTokPublishStatus(
  options: PollTikTokPublishStatusOptions,
): Promise<void> {
  const {
    accessToken,
    publishId,
    connection,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    maxAttempts = TIKTOK_POLL_MAX_ATTEMPTS,
    intervalMs = TIKTOK_POLL_INTERVAL_MS,
    deadline,
    now = Date.now,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Step budget: only wait + check when both can finish before the deadline.
    if (remainingMs(deadline, now()) < intervalMs + MIN_REQUEST_WINDOW_MS) break;
    await sleep(intervalMs);

    let publishStatus: string | undefined;
    let failReason: string | null = null;
    let unauthorized = false;
    try {
      const statusRes = await fetchWithTimeout(
        `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ publish_id: publishId }),
        },
        Math.min(TIKTOK_STATUS_TIMEOUT_MS, Math.max(remainingMs(deadline, now()), 1)),
      );

      if (statusRes.status === 401) {
        unauthorized = true;
      } else if (!statusRes.ok) {
        // Transient HTTP error: log and retry on the next iteration.
        console.warn(`[TikTok] Status check ${attempt + 1}/${maxAttempts} HTTP ${statusRes.status}`);
        continue;
      } else {
        const statusJson = (await statusRes.json()) as TikTokStatusResponse;
        publishStatus = statusJson?.data?.status;
        failReason = sanitizeFailReason(statusJson?.data?.fail_reason);
      }
    } catch (statusError) {
      // Transient fetch/parse error: log and retry on the next iteration.
      const message = statusError instanceof Error ? statusError.message : String(statusError);
      console.warn(`[TikTok] Status check ${attempt + 1} failed:`, message);
      continue;
    }

    // Decide OUTSIDE the try/catch above so terminal outcomes are not
    // swallowed by the transient-error handler.
    if (unauthorized) {
      // 2026-11-02 scale audit (jobs, token refresh): this comes AFTER the
      // commit (the final chunk is up and TikTok may be posting), so the user must
      // not be told to reconnect and retry: that can post twice. Flag (guarded by
      // the tokens used here) so the dashboard shows Reconnect, but report the
      // outcome as unknown whether or not the flag was written.
      await flagTikTokRejection(connection, "publish/status/fetch");
      throw publishUnconfirmedError("tiktok", new Error("publish/status/fetch answered HTTP 401"));
    }

    const decision = decidePollOutcome(publishStatus);
    if (decision === "complete") return;
    if (decision === "failed") {
      const error = new Error(
        failReason
          ? `TikTok failed to process the video: ${failReason}`
          : "TikTok failed to process the video",
      ) as Error & { code: string };
      error.code = "TIKTOK_PUBLISH_FAILED";
      throw error;
    }

    // Still pending (PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / unknown).
    console.log(`[TikTok] Status check ${attempt + 1}/${maxAttempts}:`, {
      status: publishStatus ?? "unknown",
      publishId,
    });
  }

  // Budget exhausted without TikTok confirming or denying the post: the video
  // may still be processing and appear on the account. Distinct from a hard
  // failure so the user checks TikTok before retrying (retrying can duplicate).
  console.warn("[TikTok] Publish status not confirmed before the poll budget ran out", {
    publishId,
    note: "Video may still be processing on TikTok.",
  });
  const error = new Error(
    "TikTok is still processing this video — it may still appear on your account. Check TikTok before retrying.",
  ) as Error & { code: string };
  error.code = "TIKTOK_PUBLISH_PENDING";
  throw error;
}

/**
 * Fetch TikTok creator info - REQUIRED by TikTok Developer Guidelines
 * Must be called before posting to get privacy options, interaction settings, and posting limits
 */
export async function getTikTokCreatorInfo(
  accessToken: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<TikTokCreatorInfo> {
  const response = await fetchWithTimeout(
    `${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
    timeoutMs,
  );

  // 2026-11-01 scale audit (platform limits): HTTP 429, or `rate_limit_exceeded`
  // in the body, is RATE_LIMITED rather than TIKTOK_CREATOR_INFO_FAILED.
  const limited = await classifyRateLimit("tiktok", response);
  if (limited) throw limited;

  await assertOk(response, {
    code: "TIKTOK_CREATOR_INFO_FAILED",
    prefix: "Failed to fetch TikTok creator info",
  });

  const json = await response.json() as TikTokCreatorInfoResponse;
  const data = json?.data;

  if (!data) {
    throw new Error("TikTok creator_info returned no data");
  }

  return {
    creatorUsername: data.creator_username || "Unknown",
    creatorAvatarUrl: data.creator_avatar_url || "",
    privacyLevelOptions: data.privacy_level_options || ["SELF_ONLY"],
    commentDisabled: data.comment_disabled || false,
    duetDisabled: data.duet_disabled || false,
    stitchDisabled: data.stitch_disabled || false,
    maxVideoPostDurationSec: data.max_video_post_duration_sec || 60,
  };
}

/**
 * The creator_info check TikTok's Developer Guidelines require before any post. It
 * proves the account can post, and fails with the reconnect code on a 401. Shared by
 * the whole-file path and the first step of a streamed upload.
 */
async function verifyCreatorInfo(
  accessToken: string,
  socialConnection: SocialConnection,
  deadline: number | undefined,
): Promise<void> {
  // REQUIRED: Call creator_info API before posting to verify account status
  // This is mandatory per TikTok Developer Guidelines
  console.log('[TikTok] Fetching creator info to verify account status...');
  // Budget check outside the try below: an exhausted budget is not a
  // creator_info failure (nothing is sent; see the STEP BUDGET note above).
  const creatorInfoTimeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline);
  try {
    const creatorInfo = await getTikTokCreatorInfo(accessToken, creatorInfoTimeoutMs);
    console.log('[TikTok] Creator info retrieved:', {
      username: creatorInfo.creatorUsername,
      privacyOptions: creatorInfo.privacyLevelOptions,
      maxDuration: creatorInfo.maxVideoPostDurationSec,
    });

    // Verify the account has the required privacy options for sandbox mode
    if (!creatorInfo.privacyLevelOptions.includes('SELF_ONLY')) {
      console.warn('[TikTok] Account may not support SELF_ONLY privacy level', {
        availableOptions: creatorInfo.privacyLevelOptions,
      });
    }
  } catch (creatorInfoError: unknown) {
    console.error('[TikTok] Failed to fetch creator info:', creatorInfoError);
    // Keep the typed rate-limit error (platform / kind / retryAt) intact
    // instead of re-wrapping it below as a plain creator_info failure.
    if (isRateLimitedError(creatorInfoError)) throw creatorInfoError;
    const cause = creatorInfoError as Error & { code?: string; status?: number };
    // A 401 means the access token is no longer valid -> reconnect.
    if (cause.status === 401) {
      await throwTikTokReconnect(socialConnection, "creator_info/query");
    }
    const error = new Error(
      `TikTok creator_info check failed: ${cause.message}`,
    ) as Error & { code: string };
    error.code = cause.code ?? "TIKTOK_CREATOR_INFO_FAILED";
    throw error;
  }
}

/** The post_info TikTok's video/init takes: the title and the user's form selections (or sandbox defaults). */
function buildPostInfo(ctx: PublishContext, tiktokCaption: string): TikTokPostInfo {
  // Use metadata from user's form selections, or defaults for sandbox mode
  const tiktokMeta = ctx.tiktokMetadata;
  const postInfo: TikTokPostInfo = {
    title: tiktokCaption,
    privacy_level: tiktokMeta?.privacyLevel || "SELF_ONLY",
    disable_comment: tiktokMeta?.disableComment ?? false,
    disable_duet: tiktokMeta?.disableDuet ?? false,
    disable_stitch: tiktokMeta?.disableStitch ?? false,
    video_cover_timestamp_ms: 1000,
  };

  // Add commercial content disclosure if specified
  if (tiktokMeta?.brandedContent || tiktokMeta?.brandOrganic) {
    postInfo.disclosure_settings = {
      disclosure_type: "BRANDED_CONTENT",
    };
    if (tiktokMeta.brandOrganic) {
      postInfo.brand_organic_type = "CREATOR_BRAND";
    }
    if (tiktokMeta.brandedContent) {
      postInfo.brand_content_type = "BRANDED_CONTENT";
    }
  }
  return postInfo;
}

/**
 * Ask TikTok's Direct Post API for a FILE_UPLOAD upload: the publish id and the
 * `upload_url` to PUT the chunks to. Not the commit call (nothing is posted until the
 * final chunk is in), so a 5xx or a network error is an ordinary failure.
 *
 * Failures: a rate limit (HTTP 429, or `rate_limit_exceeded` in the body of a 200) is
 * RATE_LIMITED; a 401 or an `access_token_invalid` body flags the connection (guarded
 * by the tokens used) and throws the reconnect code; the rest are TIKTOK_INIT_FAILED,
 * TIKTOK_INIT_ERROR and TIKTOK_INIT_MISSING_FIELDS. The response is logged without its
 * `data`, which holds the capability URL.
 */
async function requestUploadInit(args: {
  accessToken: string;
  socialConnection: SocialConnection;
  postInfo: TikTokPostInfo;
  size: number;
  chunkSize: number;
  totalChunks: number;
  deadline: number | undefined;
}): Promise<{ uploadUrl: string; publishId: string }> {
  const { accessToken, socialConnection, postInfo, size, chunkSize, totalChunks, deadline } = args;

  // Use Direct Post API with FILE_UPLOAD and captions
  const initRes = await fetchWithTimeout(
    `${TIKTOK_API_BASE}/v2/post/publish/video/init/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: postInfo,
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks,
        },
      }),
    },
    budgetedTimeout(TIKTOK_INIT_TIMEOUT_MS, deadline),
  );

  // HTTP 429, or `rate_limit_exceeded` in the body of a 200, is RATE_LIMITED.
  // Classified from a clone, so the body is still parsed below.
  const initLimited = await classifyRateLimit("tiktok", initRes);
  if (initLimited) throw initLimited;

  // A 401 means the access token is no longer valid -> reconnect.
  if (initRes.status === 401) {
    await throwTikTokReconnect(socialConnection, "video/init");
  }

  await assertOk(initRes, {
    code: "TIKTOK_INIT_FAILED",
    prefix: "Failed to start TikTok video upload",
  });

  const initJson = (await initRes.json().catch(() => null)) as TikTokInitResponse | null;
  const initErrorCode = initJson?.error?.code;
  // TikTok can also report an invalid token as an error code in the body.
  if (initErrorCode === "access_token_invalid") {
    await throwTikTokReconnect(socialConnection, "video/init");
  }
  if (initErrorCode && initErrorCode !== "ok") {
    // 2026-11-02 scale audit (jobs B3): `data` holds the upload_url, so only `error` is logged.
    console.error("[TikTok] video init error payload", { error: initJson?.error });
    const error = new Error("TikTok video init returned an error") as Error & { code: string };
    error.code = "TIKTOK_INIT_ERROR";
    throw error;
  }

  const uploadUrl = initJson?.data?.upload_url as string | undefined;
  const publishId = initJson?.data?.publish_id as string | undefined;

  if (!uploadUrl || !publishId) {
    console.error("[TikTok] video init missing upload_url or publish_id", {
      hasUploadUrl: Boolean(uploadUrl),
      hasPublishId: Boolean(publishId),
      error: initJson?.error,
    });
    const error = new Error("TikTok did not return upload_url or publish_id") as Error & { code: string };
    error.code = "TIKTOK_INIT_MISSING_FIELDS";
    throw error;
  }

  return { uploadUrl, publishId };
}

/**
 * The streamed path (2026-11-02 scale audit, jobs B3): the video is read from storage
 * one chunk at a time and PUT to TikTok's upload_url, across steps.
 *
 * - First step (`resumed` is null): `video/init`, saved at once - the upload_url sealed -
 *   before the first chunk. A step that resumes does not call creator_info or
 *   `video/init`, which keeps init under 6 a minute.
 * - One GET of the blob serves the whole step; one chunk (10 MiB, the last under 20 MiB)
 *   is held at a time.
 * - A chunk that is not the last starts only with LARGE_UPLOAD_CHUNK_WINDOW_MS left, the
 *   last (the commit call) only with {@link TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS} left. A step
 *   that cannot start the next chunk saves and continues. The progress is saved after
 *   every accepted chunk.
 * - A chunk that is not the last commits nothing, so a 5xx, a timeout, a dropped
 *   connection, or running into the deadline saves and continues; the same chunk is sent
 *   again in the next step. A 206 advances; a 416 resyncs to the position TikTok reports
 *   (see {@link resyncedChunk}); a 403 (the URL expired) starts a new upload from chunk 0;
 *   anything else is TIKTOK_UPLOAD_FAILED. A rate limit saves, then throws RATE_LIMITED.
 * - The last chunk goes through commitRequest (a 5xx or a timeout there is
 *   PUBLISH_UNCONFIRMED and is never resent), then the status poll runs in the same step.
 */
async function publishStreamed(args: {
  ctx: PublishContext;
  socialConnection: SocialConnection;
  accessToken: string;
  store: UploadStateStore;
  plan: ChunkPlan;
  size: number;
  resumed: TikTokUploadSession | null;
}): Promise<PublishResult> {
  const { ctx, socialConnection, accessToken, store, plan, size, resumed } = args;
  const { mediaItem, deadline } = ctx;
  const { chunkSize, totalChunks, ranges } = plan;

  const saveSession = (session: TikTokUploadSession) =>
    store.save<TikTokUploadData, TikTokUploadSecret>(TIKTOK_UPLOAD_STATE_KIND, {
      data: {
        publishId: session.publishId,
        initAt: session.initAt,
        size,
        chunkSize,
        totalChunks,
        nextChunk: session.nextChunk,
      },
      secret: { uploadUrl: session.uploadUrl },
    });

  /** A new upload on TikTok, positioned at chunk 0 and saved at once. */
  const beginUpload = async (): Promise<TikTokUploadSession> => {
    console.log("[TikTok] Initializing upload with FILE_UPLOAD (chunked, streamed from storage)", {
      videoSize: size,
      chunkSize,
      totalChunks,
    });
    const issuedAt = Date.now();
    const { uploadUrl, publishId } = await requestUploadInit({
      accessToken,
      socialConnection,
      postInfo: buildPostInfo(ctx, computeTikTokCaption(ctx.caption)),
      size,
      chunkSize,
      totalChunks,
      deadline,
    });
    if (!isHttpsUrl(uploadUrl)) {
      const error = new Error("TikTok did not return a usable upload_url") as Error & { code: string };
      error.code = "TIKTOK_INIT_MISSING_FIELDS";
      throw error;
    }
    const session: TikTokUploadSession = { publishId, uploadUrl, initAt: issuedAt, nextChunk: 0 };
    await saveSession(session);
    return session;
  };

  let current = resumed ?? (await beginUpload());
  let renewals = 0;
  // Held in an object so the finally block sees the stream a closure opened.
  const source: { stream: BlobChunkStream | null } = { stream: null };

  const pause = async (): Promise<PublishResult> => {
    await saveSession(current);
    console.log("[TikTok] Streamed upload continues in another step", {
      nextChunk: current.nextChunk,
      totalChunks,
    });
    return { continuation: { resumeAt: null } };
  };

  /** The bytes `start..end-1` of the video (one open stream, read in order; reopened at `start` after a jump). */
  const readChunk = async (start: number, end: number): Promise<Buffer<ArrayBuffer>> => {
    if (source.stream !== null && source.stream.position !== start) {
      await source.stream.close();
      source.stream = null;
    }
    source.stream ??= await openBlobChunkStream(mediaItem.storageLocation, {
      offset: start,
      totalBytes: size,
      deadline,
    });
    // Read into Buffer.allocUnsafe (largeUpload.ts), so it is ArrayBuffer-backed: the cast
    // only narrows the type `read` widens.
    return (await source.stream.read(end - start)) as Buffer<ArrayBuffer>;
  };

  try {
    for (;;) {
      const index = current.nextChunk;
      const { start, end } = ranges[index];
      const isFinal = index === totalChunks - 1;

      const needed = isFinal ? TIKTOK_FINAL_CHUNK_MIN_WINDOW_MS : LARGE_UPLOAD_CHUNK_WINDOW_MS;
      if (remainingMs(deadline) < needed) return await pause();

      // The URL is about to expire (and the final chunk has not been sent): start over on a new one.
      const urlLeftMs = TIKTOK_UPLOAD_URL_TTL_MS - (Date.now() - current.initAt);
      if (urlLeftMs < TIKTOK_UPLOAD_URL_SAFETY_MS && renewals < TIKTOK_MAX_RENEWALS_PER_STEP) {
        renewals += 1;
        console.warn("[TikTok] The upload URL is about to expire; starting a new upload", { nextChunk: index });
        current = await beginUpload();
        continue;
      }

      let body: Buffer<ArrayBuffer>;
      try {
        body = await readChunk(start, end);
      } catch (error) {
        // Reading runs into the deadline: nothing has been sent, so this is not a failure of
        // the upload. The next step reopens the blob at the same chunk.
        if (remainingMs(deadline) < needed) return await pause();
        throw error;
      }
      // Reading takes time too: the chunk (and, for the last, the poll after it) must still fit.
      if (remainingMs(deadline) < needed) return await pause();

      const uploadUrl = current.uploadUrl;
      const send = () =>
        fetchWithTimeout(
          uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Range": `bytes ${start}-${end - 1}/${size}`,
              "Content-Type": mediaItem.mimeType,
            },
            body,
          },
          // Throws before sending when the budget is spent: the upload is then incomplete,
          // and TikTok never publishes an incomplete upload.
          budgetedTimeout(TIKTOK_CHUNK_UPLOAD_TIMEOUT_MS, deadline),
        );

      let response: Response;
      try {
        // Only the final chunk is the commit call: Direct Post publishes as soon as the
        // upload completes. A 5xx, a timeout or a dropped connection there is
        // PUBLISH_UNCONFIRMED and is never resent.
        response = isFinal ? await commitRequest("tiktok", send) : await send();
      } catch (error) {
        // A chunk that is not the last commits nothing: with no answer (or no time to ask) the
        // step saves and continues, and the next one sends the same chunk again. Failing here
        // would record the result failed and drop the state with everything uploaded so far.
        if (!isFinal && isTransientChunkFailure(error)) {
          console.warn("[TikTok] A chunk got no answer; the next step sends it again", {
            chunk: index + 1,
            totalChunks,
            status: (error as { status?: unknown } | null)?.status,
            code: (error as { code?: unknown } | null)?.code,
          });
          return await pause();
        }
        throw error;
      }

      if (!isFinal && response.status >= 500) {
        void response.body?.cancel().catch(() => {});
        console.warn("[TikTok] A chunk was answered with a server error; the next step sends it again", {
          chunk: index + 1,
          totalChunks,
          status: response.status,
        });
        return await pause();
      }

      // Only a refusal can be a rate limit. A 2xx was taken: the final chunk then goes to the
      // status poll, which decides (TikTok may be posting, and a deferral would upload the video
      // again), and an earlier chunk keeps its 2xx handling below, whatever its body says.
      const chunkLimited = response.ok ? null : await classifyRateLimit("tiktok", response);
      if (chunkLimited) throw chunkLimited;

      if (!isFinal) {
        if (response.status === 206) {
          void response.body?.cancel().catch(() => {});
          current = { ...current, nextChunk: index + 1 };
          await saveSession(current);
          console.log(`[TikTok] Chunk ${index + 1}/${totalChunks} uploaded successfully`);
          continue;
        }

        if (response.status === 403 && renewals < TIKTOK_MAX_RENEWALS_PER_STEP) {
          // The upload_url expired before this chunk. Nothing was committed: start over.
          void response.body?.cancel().catch(() => {});
          renewals += 1;
          console.warn("[TikTok] The upload URL expired; starting a new upload", { chunk: index + 1, totalChunks });
          current = await beginUpload();
          continue;
        }

        if (response.status === 416) {
          // TikTok's progress is not ours (a chunk whose answer was lost, say): carry on from
          // the position it reports, or fail before the final chunk if that cannot be trusted.
          const target = resyncedChunk(response, plan, size);
          void response.body?.cancel().catch(() => {});
          if (target === null || target === index) {
            throw tiktokUploadError(
              `Failed to upload chunk ${index + 1}/${totalChunks} to TikTok: it reported a position that does not match the video (status 416)`,
              416,
            );
          }
          console.warn("[TikTok] TikTok holds a different part of the upload; resuming from its position", {
            from: index,
            to: target,
            totalChunks,
          });
          current = { ...current, nextChunk: target };
          await saveSession(current);
          continue;
        }

        if (response.ok) {
          // 201 ("all parts uploaded") before the last chunk: TikTok thinks the upload is complete
          // and may be posting. Do not send more, and do not offer a blind retry (a second post).
          void response.body?.cancel().catch(() => {});
          throw publishUnconfirmedError(
            "tiktok",
            new Error(`Chunk ${index + 1}/${totalChunks} was answered HTTP ${response.status}, not 206`),
          );
        }
      }

      await assertOk(response, {
        code: "TIKTOK_UPLOAD_FAILED",
        prefix: `Failed to upload chunk ${index + 1}/${totalChunks} to TikTok`,
      });

      // Only the final chunk gets here: it was accepted and TikTok is posting.
      console.log(`[TikTok] Chunk ${index + 1}/${totalChunks} uploaded successfully`);
      await source.stream?.close();
      source.stream = null;

      console.log('[TikTok] Video chunks uploaded, checking publish status...', { publishId: current.publishId });

      // Poll publish status until TikTok confirms the post (uppercase statuses, ~120s budget),
      // in this same step: the commit and what follows it never cross a step boundary.
      await pollTikTokPublishStatus({
        accessToken,
        publishId: current.publishId,
        connection: socialConnection,
        deadline,
      });

      console.log('[TikTok] Video published successfully', { publishId: current.publishId });
      return { externalPostId: current.publishId };
    }
  } catch (error) {
    if (isRateLimitedError(error)) {
      // The deferral resumes from here. Best effort: a failed save must not hide the rate limit.
      await saveSession(current).catch((saveError: unknown) => {
        console.warn("[TikTok] Could not save the upload progress before the rate-limit wait", {
          code: (saveError as { code?: unknown } | null)?.code,
        });
      });
    }
    throw error;
  } finally {
    await source.stream?.close();
  }
}

export const tiktokClient: PlatformClient = {
  // Exposed so the daily connection-health sweep (inngest-functions.ts), which
  // only refreshes clients that have a refreshToken method, keeps TikTok's
  // ~24h access tokens (and 365d refresh token) alive.
  refreshToken: refreshTikTokToken,

  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { mediaItem, caption, deadline } = ctx;

    // 2026-11-02 scale audit (jobs B3): a video above 50 MiB on a platform enabled in
    // LARGE_UPLOAD_PLATFORMS - or any upload that already has saved state - is streamed
    // from storage in chunks across steps; everything else keeps the whole-file upload
    // below, unchanged. The saved state alone decides whether this step starts an upload
    // or resumes one (never `ctx.continuation`: a step whose output was lost runs again
    // with the state already there and must resume, not start a second upload), so it is
    // read before anything else.
    const store = ctx.uploadState;
    const recordedSize = mediaItem.sizeBytes;
    const recordedPlan =
      Number.isSafeInteger(recordedSize) && recordedSize > 0 ? computeChunkPlan(recordedSize) : null;
    const saved = store
      ? await store.load<TikTokUploadData, TikTokUploadSecret>(TIKTOK_UPLOAD_STATE_KIND)
      : null;
    const resumed = readSavedUpload(saved, recordedPlan, recordedSize);
    if (saved !== null && resumed === null) {
      console.warn("[TikTok] The saved upload cannot be used; a new upload starts", { size: recordedSize });
    }
    const streamed =
      store !== undefined &&
      recordedPlan !== null &&
      usesLargeUploadPath({
        platform: "tiktok",
        mimeType: mediaItem.mimeType || "",
        sizeBytes: recordedSize,
        hasState: resumed !== null,
        hasStore: true,
      })
        ? { store, plan: recordedPlan }
        : null;

    // TikTok access tokens last ~24h: refresh a stale/expiring one BEFORE any
    // API call (a terminal refresh failure flags the connection and throws
    // TIKTOK_RECONNECT_REQUIRED; a transient one throws unflagged).
    const socialConnection = await ensureFreshTikTokToken(ctx.socialConnection, deadline);
    // An in-step retry (withTransientRetries) calls publishVideo again with
    // this same ctx: hand it the refreshed connection so it neither refreshes
    // again nor re-spends the refresh token TikTok may just have rotated.
    ctx.socialConnection = socialConnection;

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for TikTok") as Error & { code: string };
      error.code = "TIKTOK_NO_ACCESS_TOKEN";
      throw error;
    }

    // creator_info runs once per upload: a streamed upload that resumes already did it.
    if (streamed === null || resumed === null) {
      await verifyCreatorInfo(accessToken, socialConnection, deadline);
    }

    console.log('[TikTok] Media item details:', {
      mimeType: mediaItem.mimeType,
      originalFilename: mediaItem.originalFilename,
      storageLocation: mediaItem.storageLocation,
    });

    if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith("video/")) {
      const error = new Error(`TikTok requires video files. Current mime type: ${mediaItem.mimeType || 'undefined'}`) as Error & { code: string };
      error.code = "TIKTOK_MEDIA_NOT_VIDEO";
      throw error;
    }

    if (streamed !== null) {
      return publishStreamed({
        ctx,
        socialConnection,
        accessToken,
        store: streamed.store,
        plan: streamed.plan,
        size: recordedSize,
        resumed,
      });
    }

    // Download video from Vercel Blob Storage.
    // fetchWithTimeout's own timeoutMs only bounds the connection + response
    // headers; pass AbortSignal.timeout as init.signal to also bound the
    // arrayBuffer() body transfer (see the fetchWithTimeout docstring).
    const videoUrl = mediaItem.storageLocation;
    const downloadTimeoutMs = budgetedTimeout(TIKTOK_DOWNLOAD_TIMEOUT_MS, deadline);
    const videoResponse = await fetchWithTimeout(
      videoUrl,
      { signal: AbortSignal.timeout(downloadTimeoutMs) },
      downloadTimeoutMs,
    );
    await assertOk(videoResponse, {
      code: "TIKTOK_FETCH_VIDEO_FAILED",
      prefix: "Failed to fetch video from storage",
    });

    const fileBytes = Buffer.from(await videoResponse.arrayBuffer());
    const size = fileBytes.byteLength;

    // TikTok title has a 2200 character limit (see lib/platformLimits.ts), but
    // captions are typically shorter. Truncate if needed to avoid API rejection.
    const tiktokCaption = computeTikTokCaption(caption);

    // TikTok FILE_UPLOAD chunking (see computeChunkPlan): chunk_size is capped at
    // 10MB, total_chunk_count is floor(size / chunk_size), and the FINAL chunk
    // absorbs the trailing bytes so the entire file is uploaded.
    const { chunkSize: CHUNK_SIZE, totalChunks, ranges } = computeChunkPlan(size);

    console.log('[TikTok] Initializing upload with FILE_UPLOAD (chunked)', {
      videoSize: size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      hasAccessToken: !!accessToken,
      captionPreview: tiktokCaption.substring(0, 100) + (tiktokCaption.length > 100 ? '...' : ''),
    });

    const postInfo = buildPostInfo(ctx, tiktokCaption);
    const { uploadUrl, publishId } = await requestUploadInit({
      accessToken,
      socialConnection,
      postInfo,
      size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      deadline,
    });

    console.log('[TikTok] Got upload URL, uploading video in chunks...', {
      totalChunks,
      chunkSize: CHUNK_SIZE,
    });

    // Upload video in chunks. Each PUT's Content-Range reflects the ACTUAL bytes
    // sent; the final range ends at `size`, so no trailing bytes are dropped.
    for (const [chunkIndex, { start, end }] of ranges.entries()) {
      const chunk = fileBytes.subarray(start, end);

      console.log(`[TikTok] Uploading chunk ${chunkIndex + 1}/${totalChunks}`, {
        bytes: `${start}-${end - 1}/${size}`,
      });

      const sendChunk = () =>
        fetchWithTimeout(
          uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Range": `bytes ${start}-${end - 1}/${size}`,
              "Content-Type": mediaItem.mimeType,
            },
            body: chunk,
          },
          // Throws before sending when the budget is spent: the upload is then
          // incomplete, and TikTok never publishes an incomplete upload.
          budgetedTimeout(TIKTOK_CHUNK_UPLOAD_TIMEOUT_MS, deadline),
        );
      // 2026-11-01 scale audit (jobs H6, Review Focus 5): Direct Post publishes
      // as soon as the upload completes, so ONLY the final chunk PUT is the
      // commit call. A 5xx / timeout / dropped connection there is
      // PUBLISH_UNCONFIRMED and is never re-run; the earlier chunks publish
      // nothing and stay retryable (TIKTOK_UPLOAD_FAILED carries the status).
      const isFinalChunk = chunkIndex === totalChunks - 1;
      const uploadRes = isFinalChunk ? await commitRequest("tiktok", sendChunk) : await sendChunk();

      // Only a refusal can be a rate limit: a 2xx chunk was taken, and after the final one the
      // status poll decides (a deferral would upload the video again: a second post).
      const chunkLimited = uploadRes.ok ? null : await classifyRateLimit("tiktok", uploadRes);
      if (chunkLimited) throw chunkLimited;

      await assertOk(uploadRes, {
        code: "TIKTOK_UPLOAD_FAILED",
        prefix: `Failed to upload chunk ${chunkIndex + 1}/${totalChunks} to TikTok`,
      });

      console.log(`[TikTok] Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully`);
    }

    console.log('[TikTok] Video chunks uploaded, checking publish status...', { publishId });

    // Poll publish status until TikTok confirms the post (uppercase statuses,
    // ~120s budget). Resolves only on success; FAILED, a 401, or an exhausted
    // budget (TIKTOK_PUBLISH_PENDING) throw so the job records the outcome.
    await pollTikTokPublishStatus({
      accessToken,
      publishId,
      connection: socialConnection,
      deadline,
    });

    console.log('[TikTok] Video published successfully', {
      publishId,
      privacyLevel: postInfo.privacy_level,
      note: 'In sandbox mode, videos are forced to SELF_ONLY (private) visibility. Check your private posts in TikTok.',
    });

    return {
      externalPostId: publishId,
    };
  },
};
