import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { LINKEDIN_REST_BASE_URL, linkedinRestHeaders, toLinkedInLittleText } from "@/lib/linkedinApi";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";
import {
  connectionTokenChangedError,
  flagRejectedToken,
  flagTerminalRefreshFailure,
  isTerminalRefreshFailure,
  readOAuthErrorCode,
  type TokenSnapshot,
} from "./connectionHealth";
import { refreshConnectionToken } from "./connectionRefresh";
import { commitRequest, readCommitBody, requireCommitId } from "./commitCall";
import {
  blobInterruptionDetails,
  isBlobStreamInterrupted,
  isTransientUploadFailure,
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  LARGE_UPLOAD_MAX_PART_BYTES,
  LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
  openBlobChunkStream,
  usesLargeUploadPath,
  type BlobChunkStream,
} from "./largeUpload";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { classifyRateLimit, isRateLimitedError } from "./rateLimited";

/**
 * LinkedIn API client: posts an image or a video to a company page.
 *
 * Every call to LinkedIn's API goes to its versioned REST APIs under
 * https://api.linkedin.com/rest, with the `Linkedin-Version` header from
 * lib/linkedinApi.ts (LINKEDIN_API_VERSION) and `X-Restli-Protocol-Version: 2.0.0`
 * (linkedinRestHeaders). The upload PUTs go to the URLs LinkedIn hands out.
 *
 * - Images API: `POST /rest/images?action=initializeUpload` with the page as
 *   `owner`, then a PUT of the bytes to the `uploadUrl` it answers, with the
 *   member token (the upload step the Images API page links to: "The upload call
 *   requires a valid OAuth token").
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api#upload-the-image
 * - Videos API: `POST /rest/videos?action=initializeUpload` with `fileSizeBytes`
 *   (no captions, no thumbnail), a PUT of each part to its
 *   `uploadInstructions[].uploadUrl` in byte order (no token, as the page's
 *   sample), keeping each answer's ETag, then
 *   `POST /rest/videos?action=finalizeUpload` with the `uploadToken` and the
 *   ETags as `uploadedPartIds`, in part order.
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 * - Posts API: `POST /rest/posts` as `urn:li:organization:{id}`, `visibility`
 *   PUBLIC, MAIN_FEED distribution, `lifecycleState` PUBLISHED and the image or
 *   video URN as `content.media.id`. It answers 201 with the post URN
 *   (`urn:li:share:...` or `urn:li:ugcPost:...`) in the `x-restli-id` header.
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *
 * Until 2026-11 the client used the legacy /v2/assets and /v2/ugcPosts APIs,
 * which these replace
 * (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/contentapi-migration-guide).
 */

// COR-5: LinkedIn token expiry handling.
//
// Token-material reality (see app/src/app/api/auth/linkedin/callback/route.ts):
// the connection stores a ~60-day `accessToken` and a `refreshToken` ONLY when
// LinkedIn actually returns one. Programmatic refresh tokens are issued solely
// to approved LinkedIn partner programs; standard / dev-tier apps (this app)
// receive a 60-day access token with NO refresh_token. So the correct behavior
// for the common case is a clean, coded "reconnect" failure — NOT a fabricated
// refresh. When a refresh_token IS present (partner apps) we run the standard
// refresh_token grant under the same persist discipline as googleTokens.ts:
// write ONLY accessToken + expiresAt, never refreshToken or metadata wholesale.
//
// Caveat: LinkedIn may rotate the refresh_token on refresh. Per the program-wide
// discipline (never overwrite a stored refreshToken in an update) we do not
// persist a rotated token; if rotation invalidates the stored one, the next
// cycle surfaces LINKEDIN_RECONNECT_REQUIRED — the correct user action.

const LINKEDIN_TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_DEFAULT_TOKEN_TTL_SECONDS = 5_184_000; // LinkedIn access tokens last ~60 days
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // treat tokens within 5 min of expiry as expired

// 2026-11-01 scale audit (step budget, Task 7): per-request timeouts. Each is
// clamped to the time left in the step (ctx.deadline) by budgetedTimeout, and a
// request is never started with under 5 s left (PUBLISH_TIME_BUDGET_EXCEEDED,
// nothing sent). The token refresh, initializeUpload, finalizeUpload and posts
// calls use DEFAULT_FETCH_TIMEOUT_MS (30 s); each upload PUT (the image, a
// video part) LINKEDIN_UPLOAD_TIMEOUT_MS.
const LINKEDIN_DOWNLOAD_TIMEOUT_MS = 120_000;
const LINKEDIN_UPLOAD_TIMEOUT_MS = 120_000;
// Roadmap Phase 4: the code flagged (flagRejectedToken / flagTerminalRefreshFailure)
// at every site below that throws this error (expiry guard + 401 mapping).
const LINKEDIN_RECONNECT_CODE = "LINKEDIN_RECONNECT_REQUIRED";

// 2026-11-02 scale audit (jobs B3): a video above LARGE_VIDEO_THRESHOLD_BYTES (largeUpload.ts)
// on a platform listed in LARGE_UPLOAD_PLATFORMS is read from storage one part at a time and PUT
// to LinkedIn's part URLs across steps, finalized with the parts' ETags, and posted only once
// LinkedIn reports the video AVAILABLE. Smaller videos, images, and LinkedIn not enabled keep the
// whole-file upload below, in one step.
//
// Both video paths use the Videos API (2026-11, replacing the Assets API's registerUpload /
// completeMultiPartUpload): initializeUpload always answers a multi-part upload, in parts of
// 4 MiB ("Parts are sorted by non-overlapping byte-range. The first entry is byte range: 0 -
// 4194303, the next one with 4194304 - 8388607 and so on"), so the whole-file path PUTs the
// parts of its buffer and finalizes too. The page does not say a post must wait for the video to
// be AVAILABLE, and the Posts API takes a post whose content is still processing
// (`lifecycleState` PUBLISH_REQUESTED, "published asynchronously once the processing has
// successfully completed"): the whole-file path posts right after finalizeUpload, as it posted
// right after its upload before, and the multipart path keeps its wait for AVAILABLE, which
// catches a failed processing before anything is posted.
//
// The part URLs and the `uploadToken` are capability values (whoever holds them can write to, or
// finalize, the upload). They are saved only in the sealed `secret` of the upload state
// (uploadState.ts) and never logged or put in an error.

/**
 * The `kind` of a multipart LinkedIn upload in the saved upload state (uploadState.ts). Named for
 * the Videos API: state saved by the Assets API flow before 2026-11 has another kind, and is
 * ignored rather than resumed.
 */
export const LINKEDIN_UPLOAD_STATE_KIND = "linkedin_videos_api";

/**
 * A step that has parts left to send, with the part URLs expiring in less than this (5 min),
 * initializes the video again and starts over (nothing was posted). Our own safety margin: the
 * Videos API gives one `uploadUrlsExpireAt` for all the parts ("Typically URLs expire 30 days
 * from the time an upload is initialized").
 */
export const LINKEDIN_URL_EXPIRY_SAFETY_MS = 300_000;

/**
 * Times one upload may start over because its part URLs were about to expire. Each start-over
 * leaves an unused video on LinkedIn, so it is bounded; the next one is a failure.
 */
export const LINKEDIN_MAX_UPLOAD_RESTARTS = 2;

export const LINKEDIN_NOT_PAGE_ADMIN_MESSAGE =
  "LinkedIn refused the post because the LinkedIn account you connected is not an admin of this company page. Ask a page admin to add that account as a Super admin or Content admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.";

/**
 * LinkedIn's answer when the member may not post as the organization: 403 with
 * `AUTH_DELEGATION_DENIED` from the `organizationUgcAuthorizations` check
 * ("Write to post is denied due to lack of permission"). Seen 2026-11-08 for a
 * member who was not an admin of the page. The Images and Videos APIs check the
 * same before an upload ("For images with company URN owners, the caller must
 * have ADMIN or DSC permissions for the company page") and answer 403 with
 * "Accessing this image resource is forbidden. Please check your permissions
 * for this resource" (or "video resource").
 */
export function isLinkedInPageAdminDenial(body: string): boolean {
  return (
    body.includes("AUTH_DELEGATION_DENIED") ||
    body.includes("organizationUgcAuthorizations") ||
    body.includes("Please check your permissions for this resource")
  );
}

/** Wait between two checks of the video's processing status: one check per step, a minute apart. */
export const LINKEDIN_ASSET_POLL_INTERVAL_MS = 60_000;

/**
 * How long after the upload was finalized the post waits for the video to become AVAILABLE
 * (10 min). Our own bound: the Videos API page gives none. At the cap a video that LinkedIn last
 * reported PROCESSING is posted anyway, which is what the whole-file path does right after
 * finalizeUpload; any other outcome (no answer ever, WAITING_UPLOAD, a status nobody documented)
 * is LINKEDIN_VIDEO_UPLOAD_FAILED, because it says LinkedIn never took the upload.
 */
export const LINKEDIN_ASSET_MAX_WAIT_MS = 600_000;

/**
 * When a request that commits nothing (a part, the finalize, a status check) gets no usable
 * answer, the step saves its place and the next one starts this long after: a short pause, so an
 * outage does not burn the continuations (platformSteps.ts) in a few seconds.
 */
export const LINKEDIN_TRANSIENT_RESUME_DELAY_MS = 30_000;

/** The post (the commit call) starts only with a full request timeout and the minimum window left; else the step continues at once. */
export const LINKEDIN_POST_MIN_WINDOW_MS = DEFAULT_FETCH_TIMEOUT_MS + MIN_REQUEST_WINDOW_MS;

const LINKEDIN_IMAGES_URL = `${LINKEDIN_REST_BASE_URL}/images`;
const LINKEDIN_VIDEOS_URL = `${LINKEDIN_REST_BASE_URL}/videos`;
const LINKEDIN_POSTS_URL = `${LINKEDIN_REST_BASE_URL}/posts`;

/** `urn:li:image:{id}`, what the Images API answers and the post takes as `content.media.id`. */
const IMAGE_URN = /^urn:li:image:[\w-]+$/;
/** `urn:li:video:{id}`, what the Videos API answers and the post takes as `content.media.id`. */
const VIDEO_URN = /^urn:li:video:[\w-]+$/;

/** The headers of every part PUT, as the Videos API page's sample sends them (and no token). */
const VIDEO_PART_HEADERS: Readonly<Record<string, string>> = { "Content-Type": "application/octet-stream" };

function isExpiredOrExpiringSoon(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded -> cannot judge; let publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

function linkedinReconnectRequiredError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    "Your LinkedIn connection has expired — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = LINKEDIN_RECONNECT_CODE;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * LinkedIn answered 401 to a publish call: the access token is no longer valid.
 * Flag the connection (Roadmap Phase 4: flag fields only, see connectionHealth.ts)
 * and throw the actionable reconnect error. The flag is guarded by the tokens the
 * rejected call sent (2026-11-02 scale audit, jobs, token refresh): if another
 * process refreshed them, or the user reconnected, since this publish read the row,
 * NOTHING is flagged and the plain, retryable CONNECTION_TOKEN_CHANGED is thrown.
 */
async function throwLinkedInReconnect(connection: TokenSnapshot): Promise<never> {
  if ((await flagRejectedToken(connection, LINKEDIN_RECONNECT_CODE)) === "superseded") {
    throw connectionTokenChangedError();
  }
  throw linkedinReconnectRequiredError();
}

/**
 * Refresh a LinkedIn access token using a stored refresh_token (partner apps
 * only). Persists ONLY accessToken + expiresAt — never refreshToken or metadata
 * — mirroring the discipline pinned by googleTokens.ts. Exported for unit tests.
 *
 * Throws (with `error.code`):
 * - `LINKEDIN_NO_REFRESH_TOKEN` if the connection has no stored refresh token.
 * - `LINKEDIN_MISSING_OAUTH_CREDENTIALS` if the OAuth client env vars are absent
 *   (a deployment problem — never flags the connection).
 * - `LINKEDIN_RECONNECT_REQUIRED` on a TERMINAL non-2xx (HTTP 400/401, e.g.
 *   invalid_grant — the shared `isTerminalRefreshFailure` rule), after marking
 *   `needsReconnect`; the sanitized refresh error rides along as `cause`.
 * - `LINKEDIN_TOKEN_REFRESH_FAILED` (sanitized, via assertOk, carrying
 *   `status`) on any other non-2xx — 429 / 5xx / invalid_client — WITHOUT
 *   flagging. The upstream body is logged server-side, never surfaced.
 * - `TOKEN_REFRESH_SUPERSEDED` instead of LINKEDIN_RECONNECT_REQUIRED when the
 *   stored tokens no longer equal the ones this refresh used (another process
 *   refreshed, or the user reconnected): nothing is flagged (2026-11-01 scale
 *   audit, jobs, token refresh - connectionRefresh.ts).
 * Network errors propagate unchanged and never flag.
 *
 * Takes no lock itself: call it through `refreshConnectionToken`
 * (connectionRefresh.ts), as ensureFreshLinkedInToken does.
 *
 * `opts.deadline` (epoch ms, publishBudget.ts): the token request timeout is
 * clamped to the time left, and with under 5 s left it throws
 * `PUBLISH_TIME_BUDGET_EXCEEDED` BEFORE any request or write (and never flags the
 * connection). Without a deadline the request keeps its 30 s default.
 */
export async function refreshLinkedInToken(
  connection: SocialConnection,
  opts?: { deadline?: number },
): Promise<SocialConnection> {
  const refreshToken = connection.refreshToken;
  if (!refreshToken) {
    const error = new Error(
      "No refresh token available for this LinkedIn connection",
    ) as Error & { code: string };
    error.code = "LINKEDIN_NO_REFRESH_TOKEN";
    throw error;
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error(
      "Missing LinkedIn OAuth credentials",
    ) as Error & { code: string };
    error.code = "LINKEDIN_MISSING_OAUTH_CREDENTIALS";
    throw error;
  }

  // Throws (before anything is sent) when the step budget is spent.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, opts?.deadline);

  console.log("[LinkedIn] Refreshing access token", { connectionId: connection.id });

  const response = await fetchWithTimeout(
    LINKEDIN_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    timeoutMs,
  );

  // Classify BEFORE assertOk consumes the body (readOAuthErrorCode reads a clone).
  const terminal =
    !response.ok &&
    isTerminalRefreshFailure(response.status, await readOAuthErrorCode(response));

  try {
    await assertOk(response, {
      code: "LINKEDIN_TOKEN_REFRESH_FAILED",
      prefix: "Failed to refresh LinkedIn access token",
    });
  } catch (error) {
    if (!terminal) {
      // 2026-11-01 audit: 429 / 5xx / invalid_client are NOT a dead grant —
      // rethrow the sanitized, status-carrying error unflagged (429/5xx stay
      // retryable in-step via withTransientRetries).
      console.warn("[LinkedIn] Token refresh failed transiently; connection left healthy", {
        connectionId: connection.id,
        status: response.status,
      });
      throw error;
    }
    // Roadmap Phase 4: a terminal 400/401 (e.g. invalid_grant) means the grant
    // is dead — mark before throwing the actionable reconnect error (flag
    // fields only; never accessToken/refreshToken), keeping the sanitized
    // refresh error as `cause` for server logs.
    await flagTerminalRefreshFailure(connection, LINKEDIN_RECONNECT_CODE);
    throw linkedinReconnectRequiredError(error);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  // Guard: fall back to LinkedIn's standard ~60-day TTL if expires_in is
  // missing/non-finite, rather than persisting an Invalid Date.
  const expiresInSeconds =
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? tokenData.expires_in
      : LINKEDIN_DEFAULT_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  // Update accessToken + expiresAt and clear the reconnect-health flags — a
  // successful refresh means the connection works again. Never refreshToken or
  // metadata. (See header.)
  const { prisma } = await import("@/lib/db");
  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: tokenData.access_token,
      expiresAt,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      refreshFailedAt: null,
    },
  });

  console.log("[LinkedIn] Access token refreshed successfully", {
    connectionId: connection.id,
  });

  return updated;
}

/**
 * Ensure the connection's access token is usable before publishing. If it is
 * expired/near-expiry: refresh it when a refresh_token is stored (partner apps),
 * otherwise throw LINKEDIN_RECONNECT_REQUIRED. A refresh failure propagates as
 * {@link refreshLinkedInToken} classified it: a terminal one is already the
 * flagged LINKEDIN_RECONNECT_REQUIRED (original error as `cause`); a transient
 * one (429 / 5xx / network) or a config problem stays unflagged so a blip never
 * marks a working connection dead (2026-11-01 audit). Returns the (possibly
 * refreshed) connection. `deadline` (epoch ms) bounds the refresh request (see
 * {@link refreshLinkedInToken}). Exported for unit tests.
 */
export async function ensureFreshLinkedInToken(
  connection: SocialConnection,
  deadline?: number,
): Promise<SocialConnection> {
  if (!isExpiredOrExpiringSoon(connection.expiresAt)) {
    return connection;
  }

  // 2026-11-01 scale audit (jobs, token refresh): the decision runs under the
  // per-connection lock on the re-read row (refreshConnectionToken), so a
  // concurrent refresh, or a reconnect, is picked up instead of overwritten or
  // flagged dead.
  return refreshConnectionToken(
    connection,
    async (current) => {
      if (current.refreshToken) {
        return refreshLinkedInToken(current, { deadline });
      }

      // Roadmap Phase 4: expired with no refresh token stored (the common
      // non-partner-app case) — mark before throwing. Guarded like the refresh
      // failures: a row whose tokens changed is not flagged.
      await flagTerminalRefreshFailure(current, LINKEDIN_RECONNECT_CODE);
      throw linkedinReconnectRequiredError();
    },
    { deadline },
  );
}

/** The member may not post as this company page (see isLinkedInPageAdminDenial): say what to do instead of a bare 403. */
function notPageAdminError(): CodedError {
  return linkedinCodedError("LINKEDIN_NOT_PAGE_ADMIN", LINKEDIN_NOT_PAGE_ADMIN_MESSAGE);
}

async function uploadImage(
  accessToken: string,
  ownerUrn: string,
  imageUrl: string,
  connection: TokenSnapshot,
  deadline?: number,
): Promise<string> {
  console.log("[LinkedIn] Starting image upload", { imageUrl });

  // Step 1: Initialize the image upload (Images API). The answer is
  // { value: { uploadUrlExpiresAt, uploadUrl, image } }.
  const registerResponse = await fetchWithTimeout(
    `${LINKEDIN_IMAGES_URL}?action=initializeUpload`,
    {
      method: "POST",
      headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: ownerUrn,
        },
      }),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  // 2026-11-01 scale audit (platform limits): LinkedIn answers a limit with
  // HTTP 429; that is RATE_LIMITED, not a *_FAILED code.
  const imageRegisterLimited = await classifyRateLimit("linkedin", registerResponse);
  if (imageRegisterLimited) throw imageRegisterLimited;

  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Image registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (registerResponse.status === 401) {
      // Roadmap Phase 4: flag before throwing (guarded, see throwLinkedInReconnect).
      await throwLinkedInReconnect(connection);
    }
    // The Images API refuses an upload owned by a page the member may not post for.
    if (registerResponse.status === 403 && isLinkedInPageAdminDenial(errorText)) {
      throw notPageAdminError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn image registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_IMAGE_REGISTRATION_FAILED";
    throw error;
  }

  const registerData = asRecord(asRecord(await registerResponse.json().catch(() => null))?.value);
  const uploadUrl = registerData?.uploadUrl;
  const imageUrn = registerData?.image;
  if (!isHttpsUrl(uploadUrl) || typeof imageUrn !== "string" || !IMAGE_URN.test(imageUrn)) {
    // The answer is not logged: it would hold the upload URL.
    throw linkedinCodedError(
      "LINKEDIN_IMAGE_REGISTRATION_FAILED",
      "LinkedIn didn't return a usable upload for the image. Nothing was posted.",
    );
  }

  console.log("[LinkedIn] Image registered", { imageUrn });

  // Step 2: Download image from blob storage.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring). Both are
  // the same budgeted value (step deadline, Task 7).
  const imageDownloadTimeoutMs = budgetedTimeout(LINKEDIN_DOWNLOAD_TIMEOUT_MS, deadline);
  const imageResponse = await fetchWithTimeout(
    imageUrl,
    { signal: AbortSignal.timeout(imageDownloadTimeoutMs) },
    imageDownloadTimeoutMs,
  );
  await assertOk(imageResponse, {
    code: "LINKEDIN_IMAGE_DOWNLOAD_FAILED",
    prefix: "Failed to download image from storage",
  });
  const imageBuffer = await imageResponse.arrayBuffer();

  // Step 3: Upload image to LinkedIn: a PUT to the upload URL, with the member
  // token (the Images API page points to the Assets API's "Upload the Image").
  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: imageBuffer,
    },
    budgetedTimeout(LINKEDIN_UPLOAD_TIMEOUT_MS, deadline),
  );

  const imageUploadLimited = await classifyRateLimit("linkedin", uploadResponse);
  if (imageUploadLimited) throw imageUploadLimited;

  await assertOk(uploadResponse, {
    code: "LINKEDIN_IMAGE_UPLOAD_FAILED",
    prefix: "LinkedIn image upload failed",
  });

  console.log("[LinkedIn] Image uploaded successfully", { imageUrn });
  return imageUrn;
}

/** The body of `POST /rest/videos?action=initializeUpload`: the page owns the video; no captions, no thumbnail. */
function videoInitializeRequest(ownerUrn: string, fileSizeBytes: number) {
  return {
    initializeUploadRequest: {
      owner: ownerUrn,
      fileSizeBytes,
      uploadCaptions: false,
      uploadThumbnail: false,
    },
  };
}

/** The body of `POST /rest/videos?action=finalizeUpload`: the part ids in the order of the upload instructions. */
function videoFinalizeRequest(video: string, uploadToken: string, partIds: string[]) {
  return {
    finalizeUploadRequest: {
      video,
      uploadToken,
      uploadedPartIds: partIds,
    },
  };
}

/**
 * The id finalizeUpload takes for a part, from the part's ETag. The Videos API page pairs
 * `ETag: "e4383924336106965d6cd2a111beaceb"` with `uploadedPartIds:
 * ["e4383924336106965d6cd2a111beaceb"]`, so one pair of enclosing double quotes is dropped; its
 * sample answer's unquoted `etag: /ambry-videoei/signedId/...` is kept as is. Empty when there is
 * no usable ETag.
 */
function partIdFromEtag(etag: string | null): string {
  const value = (etag ?? "").trim();
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

async function uploadVideo(
  accessToken: string,
  ownerUrn: string,
  videoUrl: string,
  filename: string,
  connection: TokenSnapshot,
  deadline?: number,
): Promise<string> {
  console.log("[LinkedIn] Starting video upload", { videoUrl, filename });

  // Step 1: Download video from blob storage.
  // fetchWithTimeout's own timeoutMs only bounds the connection + response
  // headers; pass AbortSignal.timeout as init.signal to also bound the
  // arrayBuffer() body transfer (see the fetchWithTimeout docstring). Both are
  // the same budgeted value (step deadline, Task 7).
  const videoDownloadTimeoutMs = budgetedTimeout(LINKEDIN_DOWNLOAD_TIMEOUT_MS, deadline);
  const videoResponse = await fetchWithTimeout(
    videoUrl,
    { signal: AbortSignal.timeout(videoDownloadTimeoutMs) },
    videoDownloadTimeoutMs,
  );
  await assertOk(videoResponse, {
    code: "LINKEDIN_VIDEO_DOWNLOAD_FAILED",
    prefix: "Failed to download video from storage",
  });
  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  const videoSize = videoBuffer.length;

  console.log("[LinkedIn] Video downloaded", { sizeBytes: videoSize });

  // Step 2: Initialize the video upload (Videos API).
  console.log("[LinkedIn] Registering video with owner", {
    ownerUrn,
    fileSizeBytes: videoSize,
  });

  const registerResponse = await fetchWithTimeout(
    `${LINKEDIN_VIDEOS_URL}?action=initializeUpload`,
    {
      method: "POST",
      headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(videoInitializeRequest(ownerUrn, videoSize)),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const videoRegisterLimited = await classifyRateLimit("linkedin", registerResponse);
  if (videoRegisterLimited) throw videoRegisterLimited;

  if (!registerResponse.ok) {
    const errorText = await registerResponse.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Video registration failed", {
      status: registerResponse.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (registerResponse.status === 401) {
      // Roadmap Phase 4: flag before throwing (guarded, see throwLinkedInReconnect).
      await throwLinkedInReconnect(connection);
    }
    // The Videos API refuses an upload owned by a page the member may not post for.
    if (registerResponse.status === 403 && isLinkedInPageAdminDenial(errorText)) {
      throw notPageAdminError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn video registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_VIDEO_REGISTRATION_FAILED";
    throw error;
  }

  // The answer holds the part URLs and the upload token, capability values, so it is never
  // logged whole (2026-11-02 scale audit, jobs B3); the video URN is logged below.
  let registerData: unknown;
  try {
    registerData = await registerResponse.json();
  } catch {
    throw uploadFailed("LinkedIn didn't return a usable upload for this video. Nothing was posted.");
  }
  const upload = readVideoUpload(registerData, videoSize);
  const partCount = upload.parts.length;

  console.log("[LinkedIn] Video registered", { videoUrn: upload.video, parts: partCount });

  // Step 3: Upload each part of the video, in byte order, keeping its ETag.
  const partIds: string[] = [];
  for (const [index, part] of upload.parts.entries()) {
    const uploadResponse = await fetchWithTimeout(
      part.url,
      {
        method: "PUT",
        // No Authorization: the Videos API page's sample PUTs a part without a token.
        headers: { ...VIDEO_PART_HEADERS },
        body: videoBuffer.subarray(part.firstByte, part.lastByte + 1),
      },
      budgetedTimeout(LINKEDIN_UPLOAD_TIMEOUT_MS, deadline),
    );

    const videoUploadLimited = await classifyRateLimit("linkedin", uploadResponse);
    if (videoUploadLimited) throw videoUploadLimited;

    // The part's own answer is not logged or quoted: it comes from the capability URL.
    void uploadResponse.body?.cancel().catch(() => {});
    if (!uploadResponse.ok) {
      throw uploadFailed(
        `LinkedIn video upload failed (part ${index + 1} of ${partCount}, status ${uploadResponse.status})`,
        uploadResponse.status,
      );
    }
    const partId = partIdFromEtag(uploadResponse.headers.get("ETag"));
    if (!partId) {
      throw uploadFailed(`LinkedIn didn't return an ETag for part ${index + 1} of ${partCount}. Nothing was posted.`);
    }
    partIds.push(partId);
  }

  // Step 4: Finalize the upload with the parts' ETags.
  const finalizeResponse = await fetchWithTimeout(
    `${LINKEDIN_VIDEOS_URL}?action=finalizeUpload`,
    {
      method: "POST",
      headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(videoFinalizeRequest(upload.video, upload.uploadToken, partIds)),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const finalizeLimited = await classifyRateLimit("linkedin", finalizeResponse);
  if (finalizeLimited) throw finalizeLimited;
  // The body is neither read nor logged (not assertOk): LinkedIn's text could quote the upload
  // token it was sent.
  void finalizeResponse.body?.cancel().catch(() => {});
  if (finalizeResponse.status === 401) await throwLinkedInReconnect(connection);
  if (!finalizeResponse.ok) {
    const status = finalizeResponse.status;
    console.error("[LinkedIn] The video upload could not be finalized", { status });
    throw uploadFailed(`LinkedIn video upload could not be completed (status ${status})`, status);
  }

  console.log("[LinkedIn] Video uploaded successfully", { videoUrn: upload.video });
  return upload.video;
}

/**
 * The body of `POST /rest/posts`, as the Posts API page's samples build it. `content` is added
 * when there is a media URN.
 */
interface LinkedInPostBody {
  author: string;
  /** In LinkedIn's `little` text format (toLinkedInLittleText). */
  commentary: string;
  visibility: "PUBLIC";
  distribution: {
    feedDistribution: "MAIN_FEED";
    targetEntities: [];
    thirdPartyDistributionChannels: [];
  };
  content?: {
    media: {
      id: string;
      title?: string;
    };
  };
  lifecycleState: "PUBLISHED";
  isReshareDisabledByAuthor: false;
}

async function createPost(
  accessToken: string,
  authorUrn: string,
  caption: string,
  connection: TokenSnapshot,
  mediaUrn?: string,
  isVideo: boolean = false,
  deadline?: number,
): Promise<string> {
  console.log("[LinkedIn] Creating post", {
    authorUrn,
    hasMedia: !!mediaUrn,
    isVideo,
  });

  const postBody: LinkedInPostBody = {
    author: authorUrn,
    // The Posts API reads `commentary` as `little` text: reserved characters are escaped so the
    // caption shows as written (a bare "(" would otherwise be read as markup).
    commentary: toLinkedInLittleText(caption),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  // Add media if provided
  if (mediaUrn) {
    // A video keeps the title the ugcPosts body gave it ("Video"); an image has none. The title
    // is optional for both (the Post schema requires it only for documents).
    postBody.content = {
      media: isVideo ? { id: mediaUrn, title: "Video" } : { id: mediaUrn },
    };

    console.log("[LinkedIn] Post body includes media", {
      mediaUrn,
      mediaType: isVideo ? "VIDEO" : "IMAGE",
      author: authorUrn,
      hasTitle: isVideo,
    });
  }

  console.log("[LinkedIn] Sending post to API", {
    endpoint: LINKEDIN_POSTS_URL,
    author: postBody.author,
    mediaType: mediaUrn ? (isVideo ? "VIDEO" : "IMAGE") : "NONE",
    hasMedia: !!mediaUrn,
  });

  // Log full post body for debugging
  console.log("[LinkedIn] Full post body:", JSON.stringify(postBody, null, 2));

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): POST /rest/posts is the
  // commit call. A 5xx, a timeout or a dropped connection after it was sent is
  // PUBLISH_UNCONFIRMED (the post may be live) and is never re-run; a 4xx / 429
  // is returned and handled below as before. The timeout is clamped to the
  // remaining step budget; a spent budget throws PUBLISH_TIME_BUDGET_EXCEEDED
  // BEFORE the request is sent (safe to retry).
  const response = await commitRequest("linkedin", () =>
    fetchWithTimeout(
      LINKEDIN_POSTS_URL,
      {
        method: "POST",
        headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify(postBody),
      },
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
    ),
  );

  const postLimited = await classifyRateLimit("linkedin", response);
  if (postLimited) throw postLimited;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unable to read error");
    console.error("[LinkedIn] Post creation failed", {
      status: response.status,
      error: errorText,
    });
    // COR-5: 401 means the access token is no longer valid -> reconnect.
    if (response.status === 401) {
      // Roadmap Phase 4: flag before throwing (guarded, see throwLinkedInReconnect).
      await throwLinkedInReconnect(connection);
    }
    // The connected member may not post as this company page (found in a live
    // post, 2026-11-08): say what to do instead of a bare 403.
    if (response.status === 403 && isLinkedInPageAdminDenial(errorText)) {
      throw notPageAdminError();
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn post creation failed (status ${response.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_POST_CREATION_FAILED";
    throw error;
  }

  // The Posts API answers "201 Created" with the post URN in the `x-restli-id`
  // header ("urn:li:share:6844785523593134080 or urn:li:ugcPost:68447855235931240",
  // posts-api), so a 201 with an empty body and the header is a success. The
  // body is read only when the header is absent.
  const headerId = response.headers.get("x-restli-id");
  let postId: string;
  if (headerId) {
    // Not read: release the connection instead of leaving the body unread.
    void response.body?.cancel().catch(() => {});
    postId = headerId;
  } else {
    // The post call answered 2xx, so the post may be live: an unreadable body is
    // PUBLISH_UNCONFIRMED, not a failure to retry (final review F4), and so is a
    // body that parsed but has no id.
    const responseData = await readCommitBody<{ id?: unknown } | null>(
      "linkedin",
      response,
      "json",
    );
    postId = requireCommitId("linkedin", responseData?.id, "x-restli-id header or id");
  }

  console.log("[LinkedIn] Post created successfully", { postId });
  return postId;
}

// ---------------------------------------------------------------------------------------------
// 2026-11-02 scale audit (jobs B3): the multipart upload of a video above 50 MiB.
// ---------------------------------------------------------------------------------------------

type CodedError = Error & { code: string; status?: number };

function linkedinCodedError(code: string, message: string, status?: number): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

/** A failure of the upload itself. Its message names no URL and quotes nothing LinkedIn sent. */
function uploadFailed(message: string, status?: number): CodedError {
  return linkedinCodedError("LINKEDIN_VIDEO_UPLOAD_FAILED", message, status);
}

function processingFailed(): CodedError {
  return linkedinCodedError(
    "LINKEDIN_VIDEO_PROCESSING_FAILED",
    "LinkedIn couldn't process the video. Nothing was posted.",
  );
}

/** One part of the video: LinkedIn's capability URL and the bytes it takes. */
interface LinkedInUploadPart {
  url: string;
  firstByte: number;
  lastByte: number;
}

/**
 * The video statuses that mean "not ready yet", as the Videos API page lists them. Only these are
 * ever written to the readable saved data as `lastStatus` (a status enum string, never a URL).
 */
const LINKEDIN_VIDEO_WAITING_STATUSES = ["PROCESSING", "WAITING_UPLOAD"] as const;
type LinkedInWaitingStatus = (typeof LINKEDIN_VIDEO_WAITING_STATUSES)[number];

function asWaitingStatus(value: unknown): LinkedInWaitingStatus | undefined {
  return LINKEDIN_VIDEO_WAITING_STATUSES.find((status) => status === value);
}

/** What a step saves as readable progress. No URL and no LinkedIn capability value may be in it (uploadState.ts). */
interface LinkedInMultipartData {
  /** The video URN (`urn:li:video:...`) the upload belongs to. */
  video: string;
  totalBytes: number;
  partCount: number;
  /** Index of the next part to send; `etags[i]` is the id finalizeUpload takes for part `i` (its ETag, see partIdFromEtag). */
  nextPart: number;
  etags: string[];
  phase: "upload" | "processing";
  /** Epoch ms finalizeUpload was accepted: the clock of the wait for the video. */
  completedAt?: number;
  /** `uploadUrlsExpireAt`: when every part URL stops working (epoch ms). */
  urlsExpireAt: number;
  /** How many times the upload started over because its URLs were about to expire. */
  restarts: number;
  /** The last readable "not ready yet" status of the video (processing phase only); absent when none, or an unknown one, was seen. */
  lastStatus?: LinkedInWaitingStatus;
}

/** What a step saves sealed: capability values. Present until the upload is finalized. */
interface LinkedInMultipartSecret {
  parts: LinkedInUploadPart[];
  /** initializeUpload's `uploadToken` ("Identifier for an upload session"); the page's samples show it empty. */
  uploadToken: string;
}

/** An upload that has been initialized on LinkedIn: where it stands, and (until finalized) how to reach it. */
interface LinkedInMultipartSession {
  data: LinkedInMultipartData;
  secret: LinkedInMultipartSecret | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isWholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The upload URLs are sent the media, so they must be https URLs. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Do the parts (in byte order) cover the video exactly, with every URL https and every part small
 * enough to hold in memory? Returns what is wrong, or null.
 */
function partsProblem(parts: LinkedInUploadPart[], totalBytes: number): string | null {
  if (parts.length === 0) return "LinkedIn didn't return any upload parts for this video. Nothing was posted.";
  let expectedFirst = 0;
  for (const part of parts) {
    if (!isHttpsUrl(part.url) || part.firstByte !== expectedFirst || part.lastByte < part.firstByte) {
      return "LinkedIn's upload parts don't match the video. Nothing was posted.";
    }
    if (part.lastByte - part.firstByte + 1 > LARGE_UPLOAD_MAX_PART_BYTES) {
      return `LinkedIn asked for upload parts larger than this app can hold in memory (${LARGE_UPLOAD_MAX_PART_BYTES / 1_048_576} MiB). Nothing was posted.`;
    }
    expectedFirst = part.lastByte + 1;
  }
  return expectedFirst === totalBytes ? null : "LinkedIn's upload parts don't match the video. Nothing was posted.";
}

/** What `initializeUpload` answered for a video, ready to use. */
interface LinkedInVideoUpload {
  video: string;
  /** In byte order. */
  parts: LinkedInUploadPart[];
  uploadToken: string;
  urlsExpireAt: number;
}

/**
 * The upload LinkedIn initialized, from the answer to `POST /rest/videos?action=initializeUpload`
 * ({ value: { uploadUrlsExpireAt, video, uploadInstructions: [{ uploadUrl, firstByte, lastByte }],
 * uploadToken } }), the parts sorted into byte order. Anything unusable is
 * LINKEDIN_VIDEO_UPLOAD_FAILED, before a byte is sent. A part larger than
 * LARGE_UPLOAD_MAX_PART_BYTES is refused here, before the first PUT: it is the memory bound of the
 * streamed path (the page's parts are 4 MiB).
 */
function readVideoUpload(body: unknown, totalBytes: number): LinkedInVideoUpload {
  const unusable = () =>
    uploadFailed("LinkedIn didn't return a usable upload for this video. Nothing was posted.");

  const value = asRecord(asRecord(body)?.value);
  const instructions = value?.uploadInstructions;
  const video = value?.video;
  const uploadToken = value?.uploadToken;
  const urlsExpireAt = value?.uploadUrlsExpireAt;
  if (
    !Array.isArray(instructions) ||
    typeof video !== "string" ||
    !VIDEO_URN.test(video) ||
    typeof uploadToken !== "string" ||
    !isFiniteNumber(urlsExpireAt)
  ) {
    throw unusable();
  }

  const parts: LinkedInUploadPart[] = [];
  for (const raw of instructions) {
    const instruction = asRecord(raw);
    if (
      !instruction ||
      !isHttpsUrl(instruction.uploadUrl) ||
      !isWholeNumber(instruction.firstByte) ||
      !isWholeNumber(instruction.lastByte)
    ) {
      throw unusable();
    }
    parts.push({ url: instruction.uploadUrl, firstByte: instruction.firstByte, lastByte: instruction.lastByte });
  }
  parts.sort((a, b) => a.firstByte - b.firstByte);
  const problem = partsProblem(parts, totalBytes);
  if (problem !== null) throw uploadFailed(problem);

  return { video, parts, uploadToken, urlsExpireAt };
}

/**
 * The saved upload, if it can be used for a video of `totalBytes`: its video, position, ETags,
 * phase and times must be coherent, and in the upload phase the sealed parts must still cover the
 * video. Anything else (another size, a bad position, a missing secret, a hand-edited row) is
 * treated as no state, and the upload starts over.
 */
function readSavedUpload(
  saved: UploadSnapshot<Partial<LinkedInMultipartData>, Partial<LinkedInMultipartSecret>> | null,
  totalBytes: number,
): LinkedInMultipartSession | null {
  const data = saved?.data;
  if (typeof data !== "object" || data === null) return null;
  const { video, partCount, nextPart, etags, phase, completedAt, urlsExpireAt, restarts } = data;

  if (typeof video !== "string" || !VIDEO_URN.test(video)) return null;
  if (data.totalBytes !== totalBytes) return null;
  if (!isWholeNumber(partCount) || partCount < 1) return null;
  if (!isWholeNumber(nextPart) || nextPart < 0 || nextPart > partCount) return null;
  if (!Array.isArray(etags) || etags.length !== nextPart || !etags.every(isText)) return null;
  if (phase !== "upload" && phase !== "processing") return null;
  if (!isFiniteNumber(urlsExpireAt) || !isWholeNumber(restarts) || restarts < 0) return null;

  const common = { video, totalBytes, partCount, nextPart, etags: [...etags], urlsExpireAt, restarts };

  if (phase === "processing") {
    // The finalize comes after the last part, and stamps its time. Nothing sealed is needed any more.
    if (nextPart !== partCount || !isFiniteNumber(completedAt)) return null;
    const lastStatus = asWaitingStatus(data.lastStatus);
    return {
      data: { ...common, phase, completedAt, ...(lastStatus === undefined ? {} : { lastStatus }) },
      secret: null,
    };
  }

  const secret = saved?.secret;
  if (typeof secret?.uploadToken !== "string" || !Array.isArray(secret.parts) || secret.parts.length !== partCount) {
    return null;
  }
  const parts: LinkedInUploadPart[] = [];
  for (const raw of secret.parts) {
    const part = asRecord(raw);
    if (!part || !isHttpsUrl(part.url) || !isWholeNumber(part.firstByte) || !isWholeNumber(part.lastByte)) return null;
    parts.push({ url: part.url, firstByte: part.firstByte, lastByte: part.lastByte });
  }
  if (partsProblem(parts, totalBytes) !== null) return null;
  return { data: { ...common, phase }, secret: { parts, uploadToken: secret.uploadToken } };
}

/**
 * Send a request that commits nothing and sort what comes back: a 429 is RATE_LIMITED (thrown),
 * a 5xx is a failure that carries its `status`, an error from the request itself is a failure,
 * anything else is the response for the caller to read. `send` is called once.
 */
async function attemptRequest(
  send: () => Promise<Response>,
): Promise<{ response: Response } | { failure: unknown }> {
  let response: Response;
  try {
    response = await send();
  } catch (failure) {
    return { failure };
  }
  const limited = await classifyRateLimit("linkedin", response);
  if (limited) throw limited;
  if (response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    return {
      failure: Object.assign(new Error(`LinkedIn answered HTTP ${response.status}`), { status: response.status }),
    };
  }
  return { response };
}

/**
 * `POST /rest/videos?action=initializeUpload` for a video of `totalBytes`: the video and the parts
 * LinkedIn wants, as a fresh session at part 0. The call commits nothing. A 429 is RATE_LIMITED,
 * a 401 goes through the guarded reconnect flag, a 403 that says the member may not post for the
 * page is LINKEDIN_NOT_PAGE_ADMIN, and any other error status is LINKEDIN_VIDEO_UPLOAD_FAILED
 * (carrying its `status`).
 *
 * A 2xx whose body cannot be read is LINKEDIN_VIDEO_UPLOAD_FAILED too, except for a `restart`
 * whose body was cut off on the way (isTransientUploadFailure): that failure is rethrown as is,
 * so the restart pauses and initializes again in the next step.
 */
async function initializeMultipartUpload(args: {
  accessToken: string;
  ownerUrn: string;
  totalBytes: number;
  connection: TokenSnapshot;
  deadline: number | undefined;
  /** Parts were already uploaded under an earlier initialization, which this one replaces. */
  restart: boolean;
}): Promise<LinkedInMultipartSession> {
  const { accessToken, ownerUrn, totalBytes, connection, deadline, restart } = args;

  const response = await fetchWithTimeout(
    `${LINKEDIN_VIDEOS_URL}?action=initializeUpload`,
    {
      method: "POST",
      headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(videoInitializeRequest(ownerUrn, totalBytes)),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const limited = await classifyRateLimit("linkedin", response);
  if (limited) throw limited;
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    await throwLinkedInReconnect(connection);
  }
  if (!response.ok) {
    // An error answer holds no upload URL (only a 2xx does), so it is logged like the other
    // refusals; it never reaches the error message.
    const errorText = await response.text().catch(() => "<unable to read response body>");
    console.error("[LinkedIn] Video upload initialization failed", { status: response.status, error: errorText });
    if (response.status === 403 && isLinkedInPageAdminDenial(errorText)) throw notPageAdminError();
    throw uploadFailed(`LinkedIn video upload initialization failed (status ${response.status})`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A restart's answer that was cut off says nothing about the initialization: the caller
    // pauses and asks again. The first initialization fails here as it always has.
    if (restart && isTransientUploadFailure(error)) throw error;
    throw uploadFailed("LinkedIn didn't return a usable upload for this video. Nothing was posted.");
  }
  const upload = readVideoUpload(body, totalBytes);
  return {
    data: {
      video: upload.video,
      totalBytes,
      partCount: upload.parts.length,
      nextPart: 0,
      etags: [],
      phase: "upload",
      urlsExpireAt: upload.urlsExpireAt,
      restarts: 0,
    },
    secret: { parts: upload.parts, uploadToken: upload.uploadToken },
  };
}

/** What a status check says about the video. A processing failure is thrown, not returned. */
type VideoVerdict =
  | { kind: "available" }
  /** Not ready yet. `status` is the video's status when it is one the page lists, else undefined. */
  | { kind: "waiting"; status: LinkedInWaitingStatus | undefined }
  /** An answer we cannot use: a 404, a body that is not JSON, or no `status` in it. */
  | { kind: "unreadable"; reason: string }
  /** No answer: a 5xx, a timeout, or a connection that dropped. Asking again is safe. */
  | { kind: "unanswered" };

/** The video status that means LinkedIn stopped without a playable video. */
const LINKEDIN_VIDEO_FAILED_STATUSES: ReadonlySet<string> = new Set(["PROCESSING_FAILED"]);

/**
 * `GET /rest/videos/{encoded video URN}`: the video's `status`. AVAILABLE is ready;
 * PROCESSING_FAILED is LINKEDIN_VIDEO_PROCESSING_FAILED (its `processingFailureReason` is logged);
 * every other status, one we do not know included, is still processing. It only reads, so it is
 * safe to ask again. A 401 goes through the guarded reconnect flag, a 429 is RATE_LIMITED, and any
 * other error status is LINKEDIN_VIDEO_UPLOAD_FAILED, apart from a 404, which is "unreadable"
 * (asked again until the wait runs out).
 */
async function checkVideoStatus(args: {
  accessToken: string;
  video: string;
  connection: TokenSnapshot;
  deadline: number | undefined;
}): Promise<VideoVerdict> {
  const { accessToken, video, connection, deadline } = args;

  const attempt = await attemptRequest(() =>
    fetchWithTimeout(
      `${LINKEDIN_VIDEOS_URL}/${encodeURIComponent(video)}`,
      {
        method: "GET",
        headers: linkedinRestHeaders(accessToken),
      },
      budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
    ),
  );
  if ("failure" in attempt) {
    if (!isTransientUploadFailure(attempt.failure)) throw attempt.failure;
    return { kind: "unanswered" };
  }

  const { response } = attempt;
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    await throwLinkedInReconnect(connection);
  }
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    return { kind: "unreadable", reason: "the status read answered 404" };
  }
  await assertOk(response, {
    code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
    prefix: "LinkedIn video status check failed",
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isTransientUploadFailure(error)) return { kind: "unanswered" };
    return { kind: "unreadable", reason: "the status answer was not JSON" };
  }

  const answer = asRecord(body);
  const status = answer?.status;
  if (typeof status !== "string") {
    return { kind: "unreadable", reason: "the status answer has no video status" };
  }
  if (status === "AVAILABLE") return { kind: "available" };
  if (LINKEDIN_VIDEO_FAILED_STATUSES.has(status)) {
    const reason = answer?.processingFailureReason;
    console.error("[LinkedIn] Video processing failed", {
      videoUrn: video,
      videoStatus: status,
      ...(typeof reason === "string" ? { processingFailureReason: reason.slice(0, 200) } : {}),
    });
    throw processingFailed();
  }
  return { kind: "waiting", status: asWaitingStatus(status) };
}

/**
 * One step of a multipart upload (2026-11-02 scale audit, jobs B3). Whether to start an upload or
 * resume one is decided by `resumed` alone - the state `load()` returned - and never by
 * `ctx.continuation`: if a step's output is lost after it continued, the same step number runs
 * again with the state already there and must resume, not initialize a second video.
 *
 * Phases, each saved before the step moves on:
 * - none: `initializeUpload` with the file size, saved at once (before the first part).
 * - upload: parts from `nextPart`, each read from the blob with one Range request for the step and
 *   PUT, without a token, to its URL as application/octet-stream, while at least
 *   LARGE_UPLOAD_CHUNK_WINDOW_MS of the step is left; the ETag of each is saved. Then
 *   `finalizeUpload` with the upload token and the ETags in part order, once; the sealed part URLs
 *   and upload token are dropped from the saved state, and the step continues after the poll
 *   interval.
 * - processing: one status check per step. AVAILABLE posts (POST /rest/posts, the commit call) in
 *   the same step, with at least LINKEDIN_POST_MIN_WINDOW_MS left, else the step continues at once;
 *   PROCESSING_FAILED is LINKEDIN_VIDEO_PROCESSING_FAILED. A status that is not ready yet continues
 *   after LINKEDIN_ASSET_POLL_INTERVAL_MS and is saved as `lastStatus`; a missing answer (a 5xx,
 *   a timeout, a 404, a body we cannot read) continues after LINKEDIN_TRANSIENT_RESUME_DELAY_MS.
 *   At LINKEDIN_ASSET_MAX_WAIT_MS since the finalize the post is made anyway (with a warning)
 *   only when LinkedIn's last readable status was PROCESSING - the whole-file path posts right
 *   after its finalize - and anything else is LINKEDIN_VIDEO_UPLOAD_FAILED, before any post.
 *
 * With the part URLs expiring in under LINKEDIN_URL_EXPIRY_SAFETY_MS and parts left, the video is
 * initialized again and uploaded from part 0 (nothing was posted), at most
 * LINKEDIN_MAX_UPLOAD_RESTARTS times. A part answered 401 or 403 is taken for an expired URL (the
 * Videos API page: "Trying to upload to expired URLs would throw a 401 error"; no token is sent
 * on a part, so it says nothing about the connection) and restarts the same way, in the next step,
 * using the same count. A part, the finalize, a status check or the initialization of a restart
 * that gets no usable answer (5xx, timeout, dropped connection) pauses for
 * LINKEDIN_TRANSIENT_RESUME_DELAY_MS and is sent again in the next step (a restart that is waiting
 * for its initialization is not counted twice); running into the step deadline pauses too. A 429
 * saves the position, then throws RATE_LIMITED.
 */
async function publishMultipart(args: {
  ctx: PublishContext;
  accessToken: string;
  authorUrn: string;
  connection: SocialConnection;
  store: UploadStateStore;
  resumed: LinkedInMultipartSession | null;
}): Promise<PublishResult> {
  const { ctx, accessToken, authorUrn, connection, store, resumed } = args;
  const { mediaItem, caption, deadline } = ctx;
  const totalBytes = mediaItem.sizeBytes;

  const save = (session: LinkedInMultipartSession) =>
    store.save<LinkedInMultipartData, LinkedInMultipartSecret>(
      LINKEDIN_UPLOAD_STATE_KIND,
      session.secret === null ? { data: session.data } : { data: session.data, secret: session.secret },
    );

  /** A new upload on LinkedIn, positioned at part 0 and saved at once. */
  const beginUpload = async (restarts: number): Promise<LinkedInMultipartSession> => {
    const registered = await initializeMultipartUpload({
      accessToken,
      ownerUrn: authorUrn,
      totalBytes,
      connection,
      deadline,
      restart: restarts > 0,
    });
    const session: LinkedInMultipartSession = { data: { ...registered.data, restarts }, secret: registered.secret };
    await save(session);
    console.log("[LinkedIn] Multipart upload registered", {
      videoUrn: session.data.video,
      parts: session.data.partCount,
    });
    return session;
  };

  let current = resumed ?? (await beginUpload(0));
  // URLs this very step was given are not checked for expiry: no loop on short-lived URLs. (The
  // check runs once, at the top; a restart in the middle of the step is not checked again.)
  const startedHere = resumed === null;
  // Held in an object so the finally block sees the stream a closure opened.
  const source: { stream: BlobChunkStream | null } = { stream: null };

  const closeSource = async () => {
    const stream = source.stream;
    source.stream = null;
    await stream?.close();
  };

  /** Save and hand the claim back: the run calls this client again, no sooner than `delayMs` from now. */
  const pause = async (delayMs: number | null): Promise<PublishResult> => {
    await save(current);
    console.log("[LinkedIn] Multipart upload continues in another step", {
      phase: current.data.phase,
      nextPart: current.data.nextPart,
      parts: current.data.partCount,
    });
    return { continuation: { resumeAt: delayMs === null ? null : Date.now() + delayMs } };
  };

  /** The next `length` bytes of the video from `offset` (one open stream, read in order). */
  const readPart = async (offset: number, length: number): Promise<Buffer<ArrayBuffer>> => {
    if (source.stream !== null && source.stream.position !== offset) await closeSource();
    source.stream ??= await openBlobChunkStream(mediaItem.storageLocation, { offset, totalBytes, deadline });
    // Read into Buffer.allocUnsafe (largeUpload.ts), so it is ArrayBuffer-backed: the cast only
    // narrows the type `read` widens.
    return (await source.stream.read(length)) as Buffer<ArrayBuffer>;
  };

  try {
    const { data: progress } = current;
    if (
      !startedHere &&
      progress.phase === "upload" &&
      progress.nextPart < progress.partCount &&
      progress.urlsExpireAt - Date.now() < LINKEDIN_URL_EXPIRY_SAFETY_MS
    ) {
      // Nothing was posted: the video left behind is simply never used.
      if (progress.restarts >= LINKEDIN_MAX_UPLOAD_RESTARTS) {
        throw uploadFailed(
          "LinkedIn's upload links kept expiring before the video was uploaded. Nothing was posted — please retry.",
        );
      }
      if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
      console.warn("[LinkedIn] The upload links are about to expire; registering the video again", {
        videoUrn: progress.video,
        nextPart: progress.nextPart,
        parts: progress.partCount,
      });
      await closeSource();
      try {
        current = await beginUpload(progress.restarts + 1);
      } catch (error) {
        // Parts are already uploaded, and the registration commits nothing: with no answer the
        // restart stays pending (the saved state is unchanged, so the retry counts it once).
        // The very first registration of an upload, with nothing uploaded yet, is not this.
        if (!isTransientUploadFailure(error)) throw error;
        console.warn("[LinkedIn] The new registration got no answer; the next step tries it again", {
          status: (error as { status?: unknown } | null)?.status,
          code: (error as { code?: unknown } | null)?.code,
        });
        return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
      }
    }

    if (current.data.phase === "upload") {
      const secret = current.secret;
      if (secret === null) {
        throw uploadFailed("The upload could not be tracked. Nothing was posted — please retry.");
      }

      while (current.data.nextPart < current.data.partCount) {
        const index = current.data.nextPart;
        const partCount = current.data.partCount;
        const part = secret.parts[index];
        const length = part.lastByte - part.firstByte + 1;

        if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);

        let body: Buffer<ArrayBuffer>;
        try {
          body = await readPart(part.firstByte, length);
        } catch (error) {
          // Reading runs into the deadline, or the blob's body drops part-way through: nothing was
          // sent, so this is not a failure of the upload. The next step reopens the blob at the same
          // part (a little later after a drop). A blob that refuses the read still fails.
          if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
          if (isBlobStreamInterrupted(error)) {
            console.warn("[LinkedIn] Reading the stored video stopped part-way through; pausing", blobInterruptionDetails(error));
            return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
          }
          throw error;
        }
        // Reading takes time too: the part must still fit.
        if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);

        const attempt = await attemptRequest(() =>
          fetchWithTimeout(
            part.url,
            // No Authorization: the Videos API page's sample PUTs a part without a token.
            { method: "PUT", headers: { ...VIDEO_PART_HEADERS }, body },
            budgetedTimeout(LARGE_UPLOAD_REQUEST_TIMEOUT_MS, deadline),
          ),
        );
        if ("failure" in attempt) {
          // A part commits nothing: with no answer (or no time to ask) the step saves and
          // continues, and the next one sends the same part again. Failing here would drop the
          // state with everything uploaded so far.
          if (!isTransientUploadFailure(attempt.failure)) throw attempt.failure;
          console.warn("[LinkedIn] A part got no answer; the next step sends it again", {
            part: index + 1,
            parts: partCount,
            status: (attempt.failure as { status?: unknown } | null)?.status,
            code: (attempt.failure as { code?: unknown } | null)?.code,
          });
          return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
        }

        const { response } = attempt;
        void response.body?.cancel().catch(() => {});
        // The part's own answer is not logged or quoted: it comes from the capability URL.
        if ((response.status === 401 || response.status === 403) && current.data.restarts < LINKEDIN_MAX_UPLOAD_RESTARTS) {
          // A part URL that is refused is taken for an expired one ("Trying to upload to expired
          // URLs would throw a 401 error"; a part carries no token, so this is never the
          // connection's). Nothing was posted. The next step starts over exactly as it does for a
          // URL that is about to expire (and counts it, and stops at the same cap): this step only
          // records that the URLs are spent.
          console.warn("[LinkedIn] A part was refused; the upload links are taken for expired", {
            part: index + 1,
            parts: partCount,
            status: response.status,
          });
          current = { ...current, data: { ...current.data, urlsExpireAt: Date.now() } };
          return await pause(null);
        }
        if (!response.ok) {
          throw uploadFailed(
            `LinkedIn video upload failed (part ${index + 1} of ${partCount}, status ${response.status})`,
            response.status,
          );
        }
        const etag = partIdFromEtag(response.headers.get("ETag"));
        if (!etag) {
          throw uploadFailed(
            `LinkedIn didn't return an ETag for part ${index + 1} of ${partCount}. Nothing was posted.`,
          );
        }
        current = {
          ...current,
          data: { ...current.data, nextPart: index + 1, etags: [...current.data.etags, etag] },
        };
        await save(current);
        console.log("[LinkedIn] Part uploaded", { part: index + 1, parts: partCount });
      }

      await closeSource();

      // The finalize commits nothing yet (the post does), so it starts with a full window left.
      if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
      const attempt = await attemptRequest(() =>
        fetchWithTimeout(
          `${LINKEDIN_VIDEOS_URL}?action=finalizeUpload`,
          {
            method: "POST",
            headers: linkedinRestHeaders(accessToken, { "Content-Type": "application/json" }),
            body: JSON.stringify(videoFinalizeRequest(current.data.video, secret.uploadToken, current.data.etags)),
          },
          budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
        ),
      );
      if ("failure" in attempt) {
        if (!isTransientUploadFailure(attempt.failure)) throw attempt.failure;
        console.warn("[LinkedIn] The finalize got no answer; the next step asks again", {
          status: (attempt.failure as { status?: unknown } | null)?.status,
          code: (attempt.failure as { code?: unknown } | null)?.code,
        });
        return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
      }
      if (attempt.response.status === 401) {
        void attempt.response.body?.cancel().catch(() => {});
        await throwLinkedInReconnect(connection);
      }
      // A refusal is a failed upload, before any post. The body is neither read nor logged (not
      // assertOk): logs become Sentry breadcrumbs, and LinkedIn's text could quote the upload
      // token it was sent.
      void attempt.response.body?.cancel().catch(() => {});
      if (!attempt.response.ok) {
        const status = attempt.response.status;
        console.error("[LinkedIn] The finalize was refused", { status });
        throw uploadFailed(`LinkedIn video upload could not be completed (status ${status})`, status);
      }

      // The part URLs and the upload token are no longer needed: the saved state drops them.
      current = { data: { ...current.data, phase: "processing", completedAt: Date.now() }, secret: null };
      console.log("[LinkedIn] Multipart upload finalized; waiting for the video", {
        videoUrn: current.data.video,
        parts: current.data.partCount,
      });
      return await pause(LINKEDIN_ASSET_POLL_INTERVAL_MS);
    }

    // processing: one status check, then the post.
    if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
    const waitOver = Date.now() - (current.data.completedAt ?? Date.now()) >= LINKEDIN_ASSET_MAX_WAIT_MS;
    const verdict = await checkVideoStatus({ accessToken, video: current.data.video, connection, deadline });

    if (verdict.kind === "waiting") {
      // The last readable status: a status the page lists is remembered, one nobody documented is not.
      const readable = { ...current.data };
      if (verdict.status === undefined) delete readable.lastStatus;
      else readable.lastStatus = verdict.status;
      current = { ...current, data: readable };

      if (!waitOver) return await pause(LINKEDIN_ASSET_POLL_INTERVAL_MS);
      // Still PROCESSING at the cap is posted, as the whole-file path posts right after its
      // finalize. WAITING_UPLOAD or a status nobody documented says LinkedIn never took the
      // upload, and nothing is posted.
      if (verdict.status !== "PROCESSING") {
        console.error("[LinkedIn] The video was never taken up by LinkedIn before the wait ran out", {
          videoUrn: current.data.video,
          videoStatus: verdict.status ?? "unknown",
        });
        throw uploadFailed("LinkedIn never started processing the uploaded video. Nothing was posted — please retry.");
      }
      console.warn("[LinkedIn] The video is still processing after the wait; posting anyway", {
        videoUrn: current.data.video,
      });
    } else if (verdict.kind === "unanswered" || verdict.kind === "unreadable") {
      // No usable answer (a 5xx, a timeout, a dropped connection, a 404, a body we cannot read):
      // ask again soon, and at the cap post only if LinkedIn last said PROCESSING - the endpoint
      // then demonstrably works, and the video is on its way. Otherwise the status read never
      // worked, and nothing is posted.
      if (!waitOver) {
        console.warn("[LinkedIn] The status check got no usable answer; the next step asks again", {
          videoUrn: current.data.video,
          reason: verdict.kind === "unreadable" ? verdict.reason : "no answer",
        });
        return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
      }
      if (current.data.lastStatus !== "PROCESSING") {
        console.error("[LinkedIn] The status checks never gave a usable answer before the wait ran out", {
          videoUrn: current.data.video,
        });
        throw uploadFailed(
          "LinkedIn's status checks never gave a usable answer. Nothing was posted — please retry.",
        );
      }
      console.warn("[LinkedIn] The status checks got no usable answer for the rest of the wait; posting anyway", {
        videoUrn: current.data.video,
      });
    }

    // The post is the commit call: it starts with its whole timeout left, and finishes in this step.
    if (remainingMs(deadline) < LINKEDIN_POST_MIN_WINDOW_MS) return await pause(null);
    const postId = await createPost(accessToken, authorUrn, caption, connection, current.data.video, true, deadline);
    console.log("[LinkedIn] Publish successful", { postId });
    return { externalPostId: postId };
  } catch (error) {
    if (isRateLimitedError(error)) {
      // The deferral resumes from here. Best effort: a failed save must not hide the rate limit.
      await save(current).catch((saveError: unknown) => {
        console.warn("[LinkedIn] Could not save the upload progress before the rate-limit wait", {
          code: (saveError as { code?: unknown } | null)?.code,
        });
      });
    }
    throw error;
  } finally {
    await closeSource();
  }
}

export const linkedinClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption, deadline } = ctx;

    // COR-5: refresh the token when a refresh_token is stored (partner apps),
    // otherwise fail with a clear reconnect error — before we use the token.
    socialConnection = await ensureFreshLinkedInToken(socialConnection, deadline);

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for LinkedIn") as Error & {
        code: string;
      };
      error.code = "LINKEDIN_NO_ACCESS_TOKEN";
      throw error;
    }

    // Check if user has organizations/company pages
    const metadata = (socialConnection.metadata as { organizations?: Array<{ id: string; name?: string }> } | null) || {};
    const organizations = metadata.organizations || [];
    
    // REQUIRE organization - never post to personal profile
    if (organizations.length === 0) {
      const error = new Error(
        "No LinkedIn company pages configured. This app only posts to company pages, not personal profiles.\n\n" +
        "To fix this:\n" +
        "1. Ensure you are an ADMINISTRATOR of a LinkedIn Company Page\n" +
        "2. Go to Settings → Connections\n" +
        "3. Disconnect and reconnect your LinkedIn account\n" +
        "4. The app will automatically detect your company pages\n\n" +
        "If this still fails, contact support with error code: LINKEDIN_NO_ORGANIZATION"
      ) as Error & { code: string };
      error.code = "LINKEDIN_NO_ORGANIZATION";
      throw error;
    }
    
    // Use first organization
    const orgId = organizations[0].id;
    const authorUrn = `urn:li:organization:${orgId}`;
    console.log("[LinkedIn] Posting as organization", {
      orgId,
      orgName: organizations[0].name,
    });

    const mediaUrl = mediaItem.storageLocation;
    const isVideo = mediaItem.mimeType.startsWith("video/");

    console.log("[LinkedIn] Starting media upload", {
      mediaUrl,
      mimeType: mediaItem.mimeType,
      isVideo,
      filename: mediaItem.originalFilename,
      authorUrn,
    });

    // 2026-11-02 scale audit (jobs B3): a video above 50 MiB on a platform enabled in
    // LARGE_UPLOAD_PLATFORMS - or any upload that already has saved state - is uploaded as a
    // multipart upload, streamed from storage part by part across steps; everything else keeps
    // the whole-file upload below, in one step. The saved state alone decides whether this step
    // starts an upload or resumes one (never `ctx.continuation`), so it is read before anything
    // is uploaded.
    const store = ctx.uploadState;
    const totalBytes = mediaItem.sizeBytes;
    const sizeIsUsable = Number.isSafeInteger(totalBytes) && totalBytes > 0;
    const saved =
      store !== undefined && isVideo && sizeIsUsable
        ? await store.load<Partial<LinkedInMultipartData>, Partial<LinkedInMultipartSecret>>(
            LINKEDIN_UPLOAD_STATE_KIND,
          )
        : null;
    const resumed = readSavedUpload(saved, totalBytes);
    if (saved !== null && resumed === null) {
      console.warn("[LinkedIn] The saved upload cannot be used; a new upload starts", { size: totalBytes });
    }
    if (
      store !== undefined &&
      isVideo &&
      sizeIsUsable &&
      usesLargeUploadPath({
        platform: "linkedin",
        mimeType: mediaItem.mimeType,
        sizeBytes: totalBytes,
        hasState: resumed !== null,
        hasStore: true,
      })
    ) {
      return await publishMultipart({
        ctx,
        accessToken,
        authorUrn,
        connection: socialConnection,
        store,
        resumed,
      });
    }

    try {
      let mediaUrn: string | undefined;

      // Upload media if present
      if (isVideo) {
        // The whole file in one step: Videos API initializeUpload, its parts, finalizeUpload.
        mediaUrn = await uploadVideo(
          accessToken,
          authorUrn,
          mediaUrl,
          mediaItem.originalFilename,
          socialConnection,
          deadline,
        );
      } else if (mediaItem.mimeType.startsWith("image/")) {
        mediaUrn = await uploadImage(accessToken, authorUrn, mediaUrl, socialConnection, deadline);
      }

      // Create the post
      console.log("[LinkedIn] Creating post with URNs", {
        authorUrn,
        mediaUrn,
        match: mediaUrn ? `Video owner and post author both use: ${authorUrn}` : "No media",
      });

      const postId = await createPost(
        accessToken,
        authorUrn,
        caption,
        socialConnection,
        mediaUrn,
        isVideo,
        deadline,
      );

      console.log("[LinkedIn] Publish successful", { postId });

      return {
        externalPostId: postId,
      };
    } catch (error) {
      console.error("[LinkedIn] Publish error", { error });
      throw error;
    }
  },
};
