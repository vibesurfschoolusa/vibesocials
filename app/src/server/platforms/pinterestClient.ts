import type { Prisma, SocialConnection } from "@prisma/client";

import { DEFAULT_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_CODE, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  PINTEREST_API_BASE_URL,
  PINTEREST_LINK_MAX,
  PINTEREST_TOKEN_URL,
  fitPinterestDescription,
  fitPinterestTitle,
  pinterestBasicAuthHeader,
  pinterestConfig,
  pinterestPinLink,
  readPinterestErrorCode,
} from "@/lib/pinterestApi";
import { mediaKindOf } from "@/lib/platformLimits";
import { trackedWebsiteLink } from "@/lib/trackingTags";
import type { UploadStateStore } from "@/server/jobs/uploadState";

import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import {
  connectionTokenChangedError,
  flagRejectedToken,
  flagTerminalRefreshFailure,
  type TokenSnapshot,
} from "./connectionHealth";
import { refreshConnectionToken } from "./connectionRefresh";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Pinterest API v5 (https://github.com/pinterest/api-description, 5.28.0, read
// 2026-11-10; endpoints and limits in lib/pinterestApi.ts).
//
// Token material (app/api/auth/pinterest/callback/route.ts): `accessToken` lives
// 30 days, `refreshToken` 60 days. Apps created after 2025-09-25 get a
// "continuous" refresh token: every refresh answers with a new one, good for
// another 60 days, so a connection that is refreshed at least every 60 days never
// lapses. The daily health sweep refreshes a token in its last 24 h
// (connectionHealthSweep.ts), which is every ~29 days.
//
// A photo is one request: POST /pins with `media_source.image_url` (Pinterest
// fetches the file from its public URL, as Instagram and Facebook do). That is
// the commit call.
//
// A video takes three stages, and Pinterest processes it between the last two:
//
//   step 1      POST /media registers the upload; the file goes to the storage
//               URL Pinterest answers with (a form POST, its fields first, the
//               file last); the media id is saved and the step ends;
//   steps 2..n  each make ONE status check (GET /media/{id}), after a durable
//               sleep: `succeeded` goes on to POST /pins in that same step;
//               `registered` / `processing` counts the check and continues;
//               `failed` ends the publish.
//
// Only the media id crosses a step. It is no capability (it cannot be used
// without the token, which is never in the state), so it is saved as plain
// `data`. Whether to upload or to check is decided by the saved state alone,
// never by `ctx.continuation`: a step whose output was lost is re-run with the
// state already there and checks the same upload instead of sending a second.
//
// UNCONFIRMED until the app has Trial access and a live test (the app request
// was filed 2026-11-10): how long Pinterest keeps an unattached upload (a saved
// one older than PINTEREST_MEDIA_MAX_AGE_MS is replaced), how long processing
// takes (PINTEREST_STATUS_MAX_CHECKS), the status of a refresh with a dead refresh
// token (400 is taken as that; see refreshPinterestToken), and whether a Trial
// app may create Pins in production at all (docs/PINTEREST_SETUP.md).

const PINTEREST_RECONNECT_CODE = "PINTEREST_RECONNECT_REQUIRED";

/** Treat an access token within 5 minutes of expiry as expired. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
/** `expires_in` when Pinterest's answer has none: its documented 30 days. */
const PINTEREST_DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The `kind` of the upload state a video publish saves between steps (uploadState.ts). */
export const PINTEREST_VIDEO_STATE_KIND = "pinterest_video";
/** The gap between two status checks, and so the wait before each one. */
export const PINTEREST_STATUS_CHECK_INTERVAL_MS = 30_000;
/** Status checks an upload is given (about 6 minutes) before PINTEREST_VIDEO_TIMEOUT. */
export const PINTEREST_STATUS_MAX_CHECKS = 12;
/** A saved upload older than this is replaced, not checked. */
export const PINTEREST_MEDIA_MAX_AGE_MS = 23 * 3_600_000;
/** How long the download from storage, and the upload to Pinterest's, may each take. */
export const PINTEREST_VIDEO_TRANSFER_TIMEOUT_MS = 120_000;
/** The second of the video used as the Pin's cover image. */
export const PINTEREST_VIDEO_COVER_SECOND = 1;

// The in-step poll, used only when no upload-state store is given (a direct
// caller, a test): a check, then a wait, up to 30 times, stopping while
// PINTEREST_PIN_RESERVE_MS is still left for POST /pins.
export const PINTEREST_POLL_INTERVAL_MS = 5_000;
export const PINTEREST_POLL_MAX_ATTEMPTS = 30;
export const PINTEREST_PIN_RESERVE_MS = 20_000;

type CodedError = Error & { code: string; status?: number };

function codedError(message: string, code: string, status?: number): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function pinterestReconnectRequiredError(): CodedError {
  return codedError(
    "Your Pinterest connection is no longer valid. Please reconnect it in Settings.",
    PINTEREST_RECONNECT_CODE,
  );
}

/**
 * Pinterest rejected the access token (401): flag the connection, guarded by the
 * tokens that call sent, and throw the reconnect error; or, when the stored
 * tokens changed meanwhile (a refresh, a reconnect), flag nothing and throw the
 * plain, retryable CONNECTION_TOKEN_CHANGED.
 */
async function throwPinterestReconnect(connection: TokenSnapshot): Promise<never> {
  if ((await flagRejectedToken(connection, PINTEREST_RECONNECT_CODE)) === "superseded") {
    throw connectionTokenChangedError();
  }
  throw pinterestReconnectRequiredError();
}

function bearerHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

/**
 * A Pinterest API call that is NOT the commit call answered with an error:
 * nothing was posted. A rate limit is RATE_LIMITED, a 401 the reconnect error,
 * anything else `failure.code` with the status (so a 5xx is retried in-step).
 * Pinterest's own text goes to the server log only.
 */
async function failPinterestCall(
  response: Response,
  connection: TokenSnapshot,
  failure: { code: string; message: string },
): Promise<never> {
  const limited = await classifyRateLimit("pinterest", response);
  if (limited) throw limited;

  const body = await response.text().catch(() => "");
  console.error(`[Pinterest] ${failure.message}`, {
    status: response.status,
    errorCode: readPinterestErrorCode(body),
    error: body.slice(0, 500),
  });
  if (response.status === 401) await throwPinterestReconnect(connection);
  throw codedError(`${failure.message} (status ${response.status})`, failure.code, response.status);
}

function isExpiredOrExpiringSoon(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded: cannot judge, let the publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

interface PinterestTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * Refresh a Pinterest access token with the stored refresh token and persist the
 * result. Also `pinterestClient.refreshToken`, which the daily health sweep calls.
 *
 * POST /oauth/token, HTTP Basic auth (app id : app secret), form body
 * `grant_type=refresh_token&refresh_token=...`. The answer carries a new access
 * token and, for a continuous refresh token, a NEW refresh token that must
 * replace the stored one; an absent or unchanged one leaves it untouched.
 *
 * Failure handling (the flag fields are written only by connectionHealth.ts,
 * never in the same update as tokens):
 *  - HTTP 400 (Pinterest refused the refresh token itself: expired, revoked) or
 *    no refresh token stored: flag needsReconnect, guarded by the tokens this
 *    refresh sent, and throw PINTEREST_RECONNECT_REQUIRED; if the stored tokens
 *    changed meanwhile, nothing is flagged and TOKEN_REFRESH_SUPERSEDED is thrown.
 *  - HTTP 401 is NOT taken as a dead grant: the token endpoint authenticates the
 *    APP (HTTP Basic, app id : secret), and Pinterest's error body has no
 *    `invalid_client` to tell the two apart. A wrong or rotated app secret would
 *    otherwise flag every Pinterest connection and email every owner. A grant
 *    that really is dead is still caught at publish time, when the API rejects
 *    the expired access token (401 -> flagged there).
 *  - 401 / 429 / 5xx / anything else: PINTEREST_TOKEN_REFRESH_FAILED with
 *    `status` (retried in-step for 429 / 5xx), unflagged. Network errors propagate.
 *  - missing app credentials: PINTEREST_MISSING_OAUTH_CREDENTIALS, unflagged (a
 *    deployment problem, not this connection's).
 *
 * Takes no lock: call it through refreshConnectionToken (connectionRefresh.ts).
 * `opts.deadline` bounds the request; with under 5 s left nothing is sent.
 */
export async function refreshPinterestToken(
  connection: SocialConnection,
  opts?: { deadline?: number },
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    console.warn("[Pinterest] No refresh token stored; marking connection for reconnect", {
      connectionId: connection.id,
    });
    await flagTerminalRefreshFailure(connection, PINTEREST_RECONNECT_CODE);
    throw pinterestReconnectRequiredError();
  }

  const config = pinterestConfig();
  if (!config) {
    console.error("[Pinterest] Missing Pinterest app credentials", { connectionId: connection.id });
    throw codedError("Missing Pinterest app credentials", "PINTEREST_MISSING_OAUTH_CREDENTIALS");
  }

  // Throws (before anything is sent) when the step budget is spent.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, opts?.deadline);

  const response = await fetchWithTimeout(
    PINTEREST_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Authorization: pinterestBasicAuthHeader(config.appId, config.appSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    },
    timeoutMs,
  );

  const rawBody = await response.text().catch(() => "");
  let tokenData: PinterestTokenResponse | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object") tokenData = parsed as PinterestTokenResponse;
  } catch {
    tokenData = null;
  }
  const accessToken =
    typeof tokenData?.access_token === "string" && tokenData.access_token !== ""
      ? tokenData.access_token
      : null;

  if (!response.ok || !accessToken) {
    // Status and Pinterest's error code only: never the request or a token.
    console.error("[Pinterest] Token refresh failed", {
      connectionId: connection.id,
      status: response.status,
      errorCode: readPinterestErrorCode(rawBody),
    });
    if (response.status === 400) {
      await flagTerminalRefreshFailure(connection, PINTEREST_RECONNECT_CODE);
      throw pinterestReconnectRequiredError();
    }
    throw codedError(
      `Pinterest did not renew this connection (status ${response.status}). If this keeps happening, reconnect Pinterest in Settings.`,
      "PINTEREST_TOKEN_REFRESH_FAILED",
      response.status,
    );
  }

  const expiresInSeconds =
    typeof tokenData?.expires_in === "number" &&
    Number.isFinite(tokenData.expires_in) &&
    tokenData.expires_in > 0
      ? tokenData.expires_in
      : PINTEREST_DEFAULT_TOKEN_TTL_SECONDS;

  // A successful refresh means the connection works again: clear stale flags
  // (they are only ever SET by a flag-only write in connectionHealth.ts).
  const data: Prisma.SocialConnectionUpdateInput = {
    accessToken,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
  };
  if (
    typeof tokenData?.refresh_token === "string" &&
    tokenData.refresh_token !== "" &&
    tokenData.refresh_token !== refreshToken
  ) {
    data.refreshToken = tokenData.refresh_token;
  }

  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({ where: { id: connection.id }, data });

  console.log("[Pinterest] Access token refreshed", {
    connectionId: connection.id,
    refreshTokenRotated: data.refreshToken !== undefined,
  });
  return updated;
}

/**
 * The connection with a usable access token: refreshed, under the per-connection
 * lock, when the token is within 5 minutes of expiry. Failures propagate as
 * {@link refreshPinterestToken} throws them.
 */
export async function ensureFreshPinterestToken(
  connection: SocialConnection,
  deadline?: number,
): Promise<SocialConnection> {
  if (!isExpiredOrExpiringSoon(connection.expiresAt)) return connection;
  return refreshConnectionToken(
    connection,
    (current) => refreshPinterestToken(current, { deadline }),
    { deadline },
  );
}

/** The board this connection posts to (chosen at connect), or null. */
function boardIdOf(connection: SocialConnection): string | null {
  const boardId = (connection.metadata as { boardId?: unknown } | null)?.boardId;
  return typeof boardId === "string" && /^\d+$/.test(boardId) ? boardId : null;
}

/**
 * The workspace's website as the Pin's destination link. Best effort: a Pin
 * without a link is still the post the user asked for, so a failed read never
 * fails the publish.
 */
async function loadPinLink(workspaceId: string): Promise<string | null> {
  try {
    const { prisma } = await import("@/lib/db");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { companyWebsite: true, trackWebsiteLinks: true },
    });
    const link = pinterestPinLink(workspace?.companyWebsite);
    if (!link || !workspace?.trackWebsiteLinks) return link;
    // A link the tags would push past Pinterest's limit goes untagged: a Pin
    // with the plain link is better than one with none.
    const tagged = trackedWebsiteLink(link, "pinterest");
    return tagged.length <= PINTEREST_LINK_MAX ? tagged : link;
  } catch (error) {
    console.warn("[Pinterest] Could not read the workspace website; creating the Pin without a link", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

type PinMediaSource =
  | { source_type: "image_url"; url: string }
  | { source_type: "video_id"; media_id: string; cover_image_key_frame_time: number };

/**
 * POST /pins: the commit call. A 5xx, a timeout or a dropped connection after it
 * was sent is PUBLISH_UNCONFIRMED (the Pin may exist) and is never re-run; a
 * 4xx / 429 is a definitive refusal, sorted below.
 */
async function createPin(args: {
  ctx: PublishContext;
  connection: SocialConnection;
  boardId: string;
  mediaSource: PinMediaSource;
}): Promise<PublishResult> {
  const { ctx, connection, boardId, mediaSource } = args;

  // Checked first, so a spent step budget sends nothing (and reads nothing).
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline);

  const title = fitPinterestTitle((ctx.baseCaption ?? ctx.mediaItem.baseCaption) || ctx.caption);
  const description = fitPinterestDescription(ctx.caption ?? "");
  const link = await loadPinLink(connection.workspaceId);

  const pin = {
    board_id: boardId,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    media_source: mediaSource,
  };

  const post = (body: object, requestTimeoutMs: number) =>
    commitRequest("pinterest", () =>
      fetchWithTimeout(
        `${PINTEREST_API_BASE_URL}/pins`,
        {
          method: "POST",
          headers: bearerHeaders(connection.accessToken, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        },
        requestTimeoutMs,
      ),
    );

  let response = await post(link ? { ...pin, link } : pin, timeoutMs);

  // Pinterest refuses some destination links (shorteners, domains it blocks), and
  // a refused link refuses the whole Pin. A 400 is a definitive "nothing was
  // created", so asking once more without the link cannot double-post; a Pin
  // without a link is still the post the user asked for.
  if (link && response.status === 400) {
    const refusal = await response.text().catch(() => "");
    console.warn("[Pinterest] Pin refused with its link; trying once without it", {
      errorCode: readPinterestErrorCode(refusal),
    });
    response = await post(pin, budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline));
  }

  const limited = await classifyRateLimit("pinterest", response);
  if (limited) throw limited;

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error("[Pinterest] Pin creation failed", {
      status: response.status,
      errorCode: readPinterestErrorCode(errorBody),
      error: errorBody.slice(0, 500),
    });
    if (response.status === 401) await throwPinterestReconnect(connection);
    if (response.status === 404) {
      throw codedError(
        "The Pinterest board this connection posts to no longer exists. Reconnect Pinterest in Settings and choose a board.",
        "PINTEREST_BOARD_NOT_FOUND",
      );
    }
    throw codedError(
      `Pinterest Pin could not be created (status ${response.status})`,
      "PINTEREST_PUBLISH_FAILED",
    );
  }

  const data = await readCommitBody<{ id?: unknown } | null>("pinterest", response, "json");
  const externalPostId = requireCommitId("pinterest", data?.id, "id");

  console.log("[Pinterest] Pin created", { boardId, externalPostId, source: mediaSource.source_type });
  return { externalPostId };
}

interface RegisteredUpload {
  mediaId: string;
  uploadUrl: string;
  uploadParameters: Record<string, string>;
}

/** POST /media: registers a video upload and answers where and how to send the file. */
async function registerVideoUpload(
  connection: SocialConnection,
  deadline: number | undefined,
): Promise<RegisteredUpload> {
  const response = await fetchWithTimeout(
    `${PINTEREST_API_BASE_URL}/media`,
    {
      method: "POST",
      headers: bearerHeaders(connection.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ media_type: "video" }),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );
  if (!response.ok) {
    await failPinterestCall(response, connection, {
      code: "PINTEREST_VIDEO_REGISTER_FAILED",
      message: "Pinterest did not accept the video upload",
    });
  }

  const data = (await response.json().catch(() => null)) as {
    media_id?: unknown;
    upload_url?: unknown;
    upload_parameters?: unknown;
  } | null;
  const mediaId = typeof data?.media_id === "string" && /^\d+$/.test(data.media_id) ? data.media_id : null;
  const uploadUrl = typeof data?.upload_url === "string" ? data.upload_url : "";
  const parameters =
    data?.upload_parameters && typeof data.upload_parameters === "object"
      ? (data.upload_parameters as Record<string, unknown>)
      : null;

  let isHttps = false;
  try {
    isHttps = new URL(uploadUrl).protocol === "https:";
  } catch {
    isHttps = false;
  }
  if (!mediaId || !parameters || !isHttps) {
    console.error("[Pinterest] Unusable answer to the video upload registration", {
      hasMediaId: mediaId !== null,
      hasParameters: parameters !== null,
      isHttps,
    });
    throw codedError(
      "Pinterest did not accept the video upload",
      "PINTEREST_VIDEO_REGISTER_FAILED",
    );
  }

  const uploadParameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "string" || typeof value === "number") uploadParameters[key] = String(value);
  }
  return { mediaId, uploadUrl, uploadParameters };
}

/**
 * Download the video from storage and send it to the URL Pinterest registered:
 * a form POST with Pinterest's fields first and the file last (the storage host
 * ignores every field after the file). Our Pinterest token is never sent there.
 * Nothing is posted by this: a failure is safe to retry from the start.
 */
async function uploadVideoFile(
  ctx: PublishContext,
  upload: RegisteredUpload,
): Promise<void> {
  const { mediaItem, deadline } = ctx;

  // fetchWithTimeout's own timeout covers connection + headers; the signal also
  // bounds the body transfer (see its docstring). Both are the budgeted value.
  const downloadTimeoutMs = budgetedTimeout(PINTEREST_VIDEO_TRANSFER_TIMEOUT_MS, deadline);
  const download = await fetchWithTimeout(
    mediaItem.storageLocation,
    { signal: AbortSignal.timeout(downloadTimeoutMs) },
    downloadTimeoutMs,
  );
  if (!download.ok) {
    console.error("[Pinterest] Could not download the video from storage", { status: download.status });
    throw codedError(
      `Failed to download video from storage (status ${download.status})`,
      "PINTEREST_VIDEO_DOWNLOAD_FAILED",
      download.status,
    );
  }
  const file = await download.blob();

  const form = new FormData();
  for (const [key, value] of Object.entries(upload.uploadParameters)) form.append(key, value);
  // A fixed name: the storage host has no use for the user's own file name.
  form.append(
    "file",
    new Blob([file], { type: mediaItem.mimeType || "video/mp4" }),
    mediaItem.mimeType === "video/quicktime" ? "video.mov" : "video.mp4",
  );

  const uploadTimeoutMs = budgetedTimeout(PINTEREST_VIDEO_TRANSFER_TIMEOUT_MS, deadline);
  const response = await fetchWithTimeout(
    upload.uploadUrl,
    { method: "POST", body: form, signal: AbortSignal.timeout(uploadTimeoutMs) },
    uploadTimeoutMs,
  );
  if (!response.ok) {
    // The storage host's answer can quote the signed fields: status only.
    void response.body?.cancel().catch(() => {});
    console.error("[Pinterest] Video upload was refused", { status: response.status });
    throw codedError(
      `Pinterest video upload failed (status ${response.status})`,
      "PINTEREST_VIDEO_UPLOAD_FAILED",
      response.status,
    );
  }
  void response.body?.cancel().catch(() => {});
  console.log("[Pinterest] Video uploaded", { mediaId: upload.mediaId, sizeBytes: file.size });
}

type MediaStatus = "succeeded" | "failed" | "pending";

/** GET /media/{id}: where Pinterest's processing of the upload stands. */
async function readMediaStatus(
  connection: SocialConnection,
  mediaId: string,
  timeoutMs: number,
): Promise<MediaStatus> {
  const response = await fetchWithTimeout(
    `${PINTEREST_API_BASE_URL}/media/${encodeURIComponent(mediaId)}`,
    { headers: bearerHeaders(connection.accessToken) },
    timeoutMs,
  );
  if (!response.ok) {
    await failPinterestCall(response, connection, {
      code: "PINTEREST_VIDEO_STATUS_FAILED",
      message: "Pinterest did not report the video's processing status",
    });
  }
  const data = (await response.json().catch(() => null)) as { status?: unknown } | null;
  const status = typeof data?.status === "string" ? data.status.toLowerCase() : "";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  // `registered`, `processing`, or an answer that says nothing: not ready yet.
  return "pending";
}

/**
 * Did a status check fail to complete (a timeout, a dropped connection, a 5xx)
 * as opposed to being answered? Those say nothing about the upload. A rate
 * limit, a rejected token and a definite 4xx (an unknown media id) are answers,
 * and keep their own handling.
 */
function isMissedStatusCheck(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  if (e?.code === FETCH_TIMEOUT_CODE) return true;
  if (e?.code === "PINTEREST_VIDEO_STATUS_FAILED") {
    return typeof e.status === "number" && e.status >= 500;
  }
  // fetch's own failure (DNS, reset): a TypeError, carrying no code of ours.
  return error instanceof TypeError;
}

function videoProcessingFailedError(): CodedError {
  return codedError(
    "Pinterest could not process this video. Nothing was posted. Try an MP4 or MOV between 4 seconds and 15 minutes long.",
    "PINTEREST_VIDEO_PROCESSING_FAILED",
  );
}

function videoTimeoutError(): CodedError {
  return codedError(
    "Pinterest took too long to process this video. Nothing was posted. Please retry.",
    "PINTEREST_VIDEO_TIMEOUT",
  );
}

/** What a video publish saves between steps (kind {@link PINTEREST_VIDEO_STATE_KIND}). Plain data. */
interface PinterestVideoState {
  mediaId: string;
  /** ISO instant the upload was registered. */
  createdAt: string;
  /** Status checks made so far (0 right after the upload). */
  checks: number;
}

/** The saved upload, or null when there is none we can use (the publish then uploads again). */
function readVideoState(data: unknown): PinterestVideoState | null {
  if (typeof data !== "object" || data === null) return null;
  const { mediaId, createdAt, checks } = data as Record<string, unknown>;
  if (typeof mediaId !== "string" || !/^\d+$/.test(mediaId)) return null;
  if (typeof checks !== "number" || !Number.isInteger(checks) || checks < 0) return null;
  return { mediaId, createdAt: typeof createdAt === "string" ? createdAt : "", checks };
}

/** A saved upload with no readable age, or one older than the limit, is not checked. */
function isStaleUpload(state: PinterestVideoState): boolean {
  const createdAt = Date.parse(state.createdAt);
  return Number.isNaN(createdAt) || Date.now() - createdAt > PINTEREST_MEDIA_MAX_AGE_MS;
}

/** Best effort: a new upload overwrites the state, and a stale one is detected again by its age. */
async function dropSavedUpload(store: UploadStateStore): Promise<void> {
  try {
    await store.clear();
  } catch (error) {
    console.warn("[Pinterest] Could not clear the saved upload state", {
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown } | null)?.code,
    });
  }
}

function continueAfterInterval(): PublishResult {
  return { continuation: { resumeAt: Date.now() + PINTEREST_STATUS_CHECK_INTERVAL_MS } };
}

/**
 * The in-step poll for a caller without an upload-state store: check, then wait,
 * until `succeeded`, while PINTEREST_PIN_RESERVE_MS is still left for POST /pins.
 * Ends in PINTEREST_VIDEO_TIMEOUT (nothing posted, safe to retry).
 */
async function waitForPinterestMedia(
  connection: SocialConnection,
  mediaId: string,
  deadline: number | undefined,
): Promise<void> {
  const pollWindowMs = () => remainingMs(deadline) - PINTEREST_PIN_RESERVE_MS;

  for (let attempt = 0; attempt < PINTEREST_POLL_MAX_ATTEMPTS; attempt++) {
    const checkWindowMs = pollWindowMs();
    if (checkWindowMs < MIN_REQUEST_WINDOW_MS) break;
    const status = await readMediaStatus(
      connection,
      mediaId,
      Math.min(DEFAULT_FETCH_TIMEOUT_MS, checkWindowMs),
    );
    if (status === "succeeded") return;
    if (status === "failed") throw videoProcessingFailedError();
    if (pollWindowMs() < PINTEREST_POLL_INTERVAL_MS + MIN_REQUEST_WINDOW_MS) break;
    await new Promise<void>((resolve) => setTimeout(resolve, PINTEREST_POLL_INTERVAL_MS));
  }
  throw videoTimeoutError();
}

async function publishPinterestVideo(
  ctx: PublishContext,
  connection: SocialConnection,
  boardId: string,
): Promise<PublishResult> {
  const store = ctx.uploadState;
  const videoSource = (mediaId: string): PinMediaSource => ({
    source_type: "video_id",
    media_id: mediaId,
    cover_image_key_frame_time: PINTEREST_VIDEO_COVER_SECOND,
  });

  let saved = store
    ? readVideoState((await store.load<unknown>(PINTEREST_VIDEO_STATE_KIND))?.data)
    : null;
  if (store && saved && isStaleUpload(saved)) {
    console.log("[Pinterest] Saved upload is too old to use; uploading again", {
      mediaId: saved.mediaId,
      createdAt: saved.createdAt,
    });
    await dropSavedUpload(store);
    saved = null;
  }

  if (store && saved) {
    // A later step: the file is with Pinterest. One status check. Before anything
    // is sent, and outside the try below: a spent step budget is retry-safe
    // (PUBLISH_TIME_BUDGET_EXCEEDED), not a check.
    const statusTimeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, ctx.deadline);
    let status: MediaStatus;
    try {
      status = await readMediaStatus(connection, saved.mediaId, statusTimeoutMs);
    } catch (error) {
      if (!isMissedStatusCheck(error)) throw error;
      // The file is uploaded and may be minutes into processing: one check that
      // did not complete counts as a check, it does not throw the upload away.
      console.error("[Pinterest] Status check did not complete; counting it as a check", {
        name: error instanceof Error ? error.name : typeof error,
        code: (error as { code?: unknown } | null)?.code,
      });
      status = "pending";
    }
    if (status === "succeeded") {
      return createPin({ ctx, connection, boardId, mediaSource: videoSource(saved.mediaId) });
    }
    if (status === "failed") {
      await dropSavedUpload(store);
      throw videoProcessingFailedError();
    }
    const checks = saved.checks + 1;
    if (checks >= PINTEREST_STATUS_MAX_CHECKS) {
      await dropSavedUpload(store);
      throw videoTimeoutError();
    }
    await store.save<PinterestVideoState>(PINTEREST_VIDEO_STATE_KIND, {
      data: { ...saved, checks },
    });
    return continueAfterInterval();
  }

  const upload = await registerVideoUpload(connection, ctx.deadline);
  await uploadVideoFile(ctx, upload);

  if (store) {
    await store.save<PinterestVideoState>(PINTEREST_VIDEO_STATE_KIND, {
      data: { mediaId: upload.mediaId, createdAt: new Date().toISOString(), checks: 0 },
    });
    return continueAfterInterval();
  }

  await waitForPinterestMedia(connection, upload.mediaId, ctx.deadline);
  return createPin({ ctx, connection, boardId, mediaSource: videoSource(upload.mediaId) });
}

export const pinterestClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    const { socialConnection, mediaItem } = ctx;

    if (!socialConnection.accessToken) {
      throw codedError("Missing access token for Pinterest", "PINTEREST_NO_ACCESS_TOKEN");
    }

    const boardId = boardIdOf(socialConnection);
    if (!boardId) {
      throw codedError(
        "No Pinterest board is chosen for this connection. Reconnect Pinterest in Settings and choose a board.",
        "PINTEREST_NO_BOARD",
      );
    }

    const kind = mediaKindOf(mediaItem.mimeType ?? "");
    if (kind === null) {
      throw codedError(
        "Pinterest posting supports images and videos. Please upload a photo or a video.",
        "PINTEREST_UNSUPPORTED_MEDIA_TYPE",
      );
    }

    console.log("[Pinterest] Starting publish", {
      kind,
      boardId,
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      captionLength: ctx.caption?.length ?? 0,
    });

    // A token in its last 5 minutes is refreshed first (terminal failure: flagged
    // PINTEREST_RECONNECT_REQUIRED; a transient one throws unflagged).
    const connection = await ensureFreshPinterestToken(socialConnection, ctx.deadline);

    if (kind === "video") return publishPinterestVideo(ctx, connection, boardId);

    return createPin({
      ctx,
      connection,
      boardId,
      mediaSource: { source_type: "image_url", url: mediaItem.storageLocation },
    });
  },

  refreshToken: refreshPinterestToken,
};
