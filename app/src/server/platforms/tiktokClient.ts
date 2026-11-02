import type { Prisma, SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS, TIKTOK_DEFAULT_CAPTION } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";

import { commitRequest } from "./commitCall";
import {
  flagTerminalRefreshFailure,
  isTerminalRefreshFailure,
  markConnectionNeedsReconnect,
} from "./connectionHealth";
import { refreshConnectionToken } from "./connectionRefresh";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
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
 * Code thrown (and recorded via markConnectionNeedsReconnect) whenever TikTok
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
 * TikTok rejected the access token (401). Flag the connection so the user sees
 * "reconnect" copy, then throw the reconnect code. Flag fields only — never
 * touches accessToken/refreshToken (see connectionHealth.ts).
 */
async function throwTikTokReconnect(connectionId: string, where: string): Promise<never> {
  console.error("[TikTok] Access token rejected; marking connection for reconnect", {
    connectionId,
    where,
  });
  await markConnectionNeedsReconnect(connectionId, TIKTOK_RECONNECT_CODE);
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
  /** Used to flag the connection if TikTok answers 401 mid-poll. */
  connectionId: string;
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
 *  - 401 -> `TIKTOK_RECONNECT_REQUIRED` (connection flagged)
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
    connectionId,
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
      await throwTikTokReconnect(connectionId, "publish/status/fetch");
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

export const tiktokClient: PlatformClient = {
  // Exposed so the daily connection-health sweep (inngest-functions.ts), which
  // only refreshes clients that have a refreshToken method, keeps TikTok's
  // ~24h access tokens (and 365d refresh token) alive.
  refreshToken: refreshTikTokToken,

  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { mediaItem, caption, deadline } = ctx;

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
        await throwTikTokReconnect(socialConnection.id, "creator_info/query");
      }
      const error = new Error(
        `TikTok creator_info check failed: ${cause.message}`,
      ) as Error & { code: string };
      error.code = cause.code ?? "TIKTOK_CREATOR_INFO_FAILED";
      throw error;
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
            chunk_size: CHUNK_SIZE,
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
      await throwTikTokReconnect(socialConnection.id, "video/init");
    }

    await assertOk(initRes, {
      code: "TIKTOK_INIT_FAILED",
      prefix: "Failed to start TikTok video upload",
    });

    const initJson = (await initRes.json().catch(() => null)) as TikTokInitResponse | null;
    const initErrorCode = initJson?.error?.code;
    // TikTok can also report an invalid token as an error code in the body.
    if (initErrorCode === "access_token_invalid") {
      await throwTikTokReconnect(socialConnection.id, "video/init");
    }
    if (initErrorCode && initErrorCode !== "ok") {
      console.error("[TikTok] video init error payload", initJson);
      const error = new Error("TikTok video init returned an error") as Error & { code: string };
      error.code = "TIKTOK_INIT_ERROR";
      throw error;
    }

    const uploadUrl = initJson?.data?.upload_url as string | undefined;
    const publishId = initJson?.data?.publish_id as string | undefined;

    if (!uploadUrl || !publishId) {
      console.error("[TikTok] video init missing upload_url or publish_id", initJson);
      const error = new Error("TikTok did not return upload_url or publish_id") as Error & { code: string };
      error.code = "TIKTOK_INIT_MISSING_FIELDS";
      throw error;
    }

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

      const chunkLimited = await classifyRateLimit("tiktok", uploadRes);
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
      connectionId: socialConnection.id,
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
