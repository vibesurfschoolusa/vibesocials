import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
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
 * LinkedIn API client for posting images and videos
 * Uses LinkedIn UGC Post API (v2) and Assets API for media upload
 * 
 * Documentation:
 * - UGC Posts: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api
 * - Assets API: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/images-api
 * 
 * Note: Both images and videos use the Assets API with UGC service relationships
 * to ensure they can be used in organic posts (not just advertising).
 */

interface LinkedInAssetUploadResponse {
  value: {
    uploadMechanism: {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
        uploadUrl: string;
        headers: Record<string, string>;
      };
    };
    asset: string;
    mediaArtifact: string;
  };
}

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
// nothing sent). The token refresh, register and ugcPosts calls use
// DEFAULT_FETCH_TIMEOUT_MS (30 s).
const LINKEDIN_DOWNLOAD_TIMEOUT_MS = 120_000;
const LINKEDIN_UPLOAD_TIMEOUT_MS = 120_000;
// Roadmap Phase 4: the code flagged (flagRejectedToken / flagTerminalRefreshFailure)
// at every site below that throws this error (expiry guard + 401 mapping).
const LINKEDIN_RECONNECT_CODE = "LINKEDIN_RECONNECT_REQUIRED";

// 2026-11-02 scale audit (jobs B3): a video above LARGE_VIDEO_THRESHOLD_BYTES (largeUpload.ts)
// on a platform listed in LARGE_UPLOAD_PLATFORMS is registered as a MULTIPART_UPLOAD, read from
// storage one part at a time and PUT to LinkedIn's part URLs across steps, completed with the
// parts' ETags, and posted only once LinkedIn reports the asset AVAILABLE. Smaller videos,
// images, and LinkedIn not enabled keep the whole-file upload below, unchanged.
//
// The Assets API page documents this flow under /rest/assets with a Linkedin-Version header and
// says the Videos API replaces it for videos:
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api
// This client keeps the /v2 endpoints that the whole-file path and ugcPosts already use. Whether
// /v2/assets?action=completeMultiPartUpload and GET /v2/assets/{id} behave like the documented
// /rest ones, and whether MULTIPART_UPLOAD is accepted below the 200 MB the page names, is
// unconfirmed: a failure there is LINKEDIN_VIDEO_UPLOAD_FAILED, before anything is posted.
//
// The part URLs and the register answer's `metadata` are capability values (whoever holds them
// can write to, or complete, the upload). They are saved only in the sealed `secret` of the
// upload state (uploadState.ts) and never logged or put in an error.

/** The `kind` of a multipart LinkedIn upload in the saved upload state (uploadState.ts). */
export const LINKEDIN_UPLOAD_STATE_KIND = "linkedin_multipart";

/**
 * A step that has parts left to send, with the earliest part URL expiring in less than this (5
 * min), registers the video again and starts over (nothing was posted). Our own safety margin:
 * the documented sample gives each part a `urlExpiresAt` but no lifetime.
 */
export const LINKEDIN_URL_EXPIRY_SAFETY_MS = 300_000;

/**
 * Times one upload may start over because its part URLs were about to expire. Each start-over
 * leaves an unused asset on LinkedIn, so it is bounded; the next one is a failure.
 */
export const LINKEDIN_MAX_UPLOAD_RESTARTS = 2;

/** Wait between two checks of the asset's processing status: one check per step, a minute apart. */
export const LINKEDIN_ASSET_POLL_INTERVAL_MS = 60_000;

/**
 * How long after the upload was completed the post waits for the asset to become AVAILABLE
 * (10 min). Our own bound: the page only says processing "might take a few minutes". At the cap
 * an asset that LinkedIn last reported PROCESSING is posted anyway, which is what the whole-file
 * path does right after its upload; any other outcome (no answer ever, WAITING_UPLOAD, NEW, a
 * status nobody documented) is LINKEDIN_VIDEO_UPLOAD_FAILED, because it says LinkedIn never
 * took the upload.
 */
export const LINKEDIN_ASSET_MAX_WAIT_MS = 600_000;

/**
 * When a request that commits nothing (a part, the completion, a status check) gets no usable
 * answer, the step saves its place and the next one starts this long after: a short pause, so an
 * outage does not burn the continuations (platformSteps.ts) in a few seconds.
 */
export const LINKEDIN_TRANSIENT_RESUME_DELAY_MS = 30_000;

/** The post (the commit call) starts only with a full request timeout and the minimum window left; else the step continues at once. */
export const LINKEDIN_POST_MIN_WINDOW_MS = DEFAULT_FETCH_TIMEOUT_MS + MIN_REQUEST_WINDOW_MS;

const LINKEDIN_ASSETS_URL = "https://api.linkedin.com/v2/assets";
const LINKEDIN_MULTIPART_MECHANISM = "com.linkedin.digitalmedia.uploading.MultipartUpload";
const LINKEDIN_VIDEO_RECIPE = "urn:li:digitalmediaRecipe:feedshare-video";

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

async function uploadImage(
  accessToken: string,
  ownerUrn: string,
  imageUrl: string,
  connection: TokenSnapshot,
  deadline?: number,
): Promise<string> {
  console.log("[LinkedIn] Starting image upload", { imageUrl });

  // Step 1: Register image upload
  const registerResponse = await fetchWithTimeout(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: ownerUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
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
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn image registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_IMAGE_REGISTRATION_FAILED";
    throw error;
  }

  const registerData: LinkedInAssetUploadResponse = await registerResponse.json();
  const uploadUrl =
    registerData.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const assetUrn = registerData.value.asset;

  console.log("[LinkedIn] Image registered", { assetUrn });

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

  // Step 3: Upload image to LinkedIn
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

  console.log("[LinkedIn] Image uploaded successfully", { assetUrn });
  return assetUrn;
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

  // Step 2: Register video upload using Assets API (for UGC, not ads)
  console.log("[LinkedIn] Registering video with owner", { 
    ownerUrn,
    fileSizeBytes: videoSize,
  });
  
  const registerResponse = await fetchWithTimeout(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
          owner: ownerUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
        },
      }),
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
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn video registration failed (status ${registerResponse.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_VIDEO_REGISTRATION_FAILED";
    throw error;
  }

  const registerData = await registerResponse.json();
  // 2026-11-02 scale audit (jobs B3): the register answer holds the upload URL, a capability
  // value, so it is no longer logged whole; the asset URN is logged below.

  const uploadUrl = registerData.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
  const assetUrn = registerData.value?.asset;
  
  if (!uploadUrl || !assetUrn) {
    throw new Error("LinkedIn video registration did not return upload URL or asset URN");
  }

  console.log("[LinkedIn] Video registered", { assetUrn });

  // Step 3: Upload video to LinkedIn
  const uploadResponse = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: videoBuffer,
    },
    budgetedTimeout(LINKEDIN_UPLOAD_TIMEOUT_MS, deadline),
  );

  const videoUploadLimited = await classifyRateLimit("linkedin", uploadResponse);
  if (videoUploadLimited) throw videoUploadLimited;

  await assertOk(uploadResponse, {
    code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
    prefix: "LinkedIn video upload failed",
  });

  console.log("[LinkedIn] Video uploaded successfully", { assetUrn });
  return assetUrn;
}

// Minimal shape of the LinkedIn UGC post body we construct. `media` is added
// conditionally when a media URN is present.
interface LinkedInShareContent {
  shareCommentary: { text: string };
  shareMediaCategory: string;
  media?: Array<{
    status: string;
    description: { text: string };
    media: string;
    title?: { text: string };
  }>;
}

interface LinkedInUgcPost {
  author: string;
  lifecycleState: string;
  specificContent: {
    "com.linkedin.ugc.ShareContent": LinkedInShareContent;
  };
  visibility: {
    "com.linkedin.ugc.MemberNetworkVisibility": string;
  };
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

  const postBody: LinkedInUgcPost = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: caption,
        },
        shareMediaCategory: mediaUrn
          ? isVideo
            ? "VIDEO"
            : "IMAGE"
          : "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  // Add media if provided
  if (mediaUrn) {
    if (isVideo) {
      // Videos require a different structure with title
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [
        {
          status: "READY",
          description: {
            text: caption || "Video"
          },
          media: mediaUrn,
          title: {
            text: "Video"
          }
        },
      ];
    } else {
      // Images use simpler structure
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media = [
        {
          status: "READY",
          description: {
            text: caption || "Image"
          },
          media: mediaUrn,
        },
      ];
    }
    
    console.log("[LinkedIn] Post body includes media", {
      mediaUrn,
      mediaType: isVideo ? "VIDEO" : "IMAGE",
      author: authorUrn,
      hasTitle: isVideo,
      hasDescription: true,
    });
  }

  console.log("[LinkedIn] Sending post to API", {
    endpoint: "https://api.linkedin.com/v2/ugcPosts",
    author: postBody.author,
    mediaCategory: postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory,
    hasMedia: !!mediaUrn,
  });
  
  // Log full post body for debugging
  console.log("[LinkedIn] Full post body:", JSON.stringify(postBody, null, 2));

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): POST /v2/ugcPosts is the
  // commit call. A 5xx, a timeout or a dropped connection after it was sent is
  // PUBLISH_UNCONFIRMED (the post may be live) and is never re-run; a 4xx / 429
  // is returned and handled below as before. The timeout is clamped to the
  // remaining step budget; a spent budget throws PUBLISH_TIME_BUDGET_EXCEEDED
  // BEFORE the request is sent (safe to retry).
  const response = await commitRequest("linkedin", () =>
    fetchWithTimeout(
      "https://api.linkedin.com/v2/ugcPosts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
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
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    const error = new Error(
      `LinkedIn post creation failed (status ${response.status})`,
    ) as Error & { code: string };
    error.code = "LINKEDIN_POST_CREATION_FAILED";
    throw error;
  }

  // 2026-11-02 scale audit (jobs): ugcPosts answers "201 Created" with the id
  // in the `x-restli-id` header
  // (https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api),
  // so a 201 with an empty body and the header is a success. The body is read only
  // when the header is absent.
  const headerId = response.headers.get("x-restli-id");
  let postId: string;
  if (headerId) {
    // Not read: release the connection instead of leaving the body unread.
    void response.body?.cancel().catch(() => {});
    postId = headerId;
  } else {
    // ugcPosts answered 2xx, so the post may be live: an unreadable body is
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

/** One part of the video: LinkedIn's capability URL, the bytes it takes, and the headers it asked for. */
interface LinkedInUploadPart {
  url: string;
  firstByte: number;
  lastByte: number;
  headers: Record<string, string>;
}

/**
 * The recipe statuses that mean "not ready yet", as the Assets API page lists them. Only these are
 * ever written to the readable saved data as `lastStatus` (a status enum string, never a URL).
 */
const LINKEDIN_RECIPE_WAITING_STATUSES = ["NEW", "PROCESSING", "WAITING_UPLOAD", "MUTATING"] as const;
type LinkedInWaitingStatus = (typeof LINKEDIN_RECIPE_WAITING_STATUSES)[number];

function asWaitingStatus(value: unknown): LinkedInWaitingStatus | undefined {
  return LINKEDIN_RECIPE_WAITING_STATUSES.find((status) => status === value);
}

/** What a step saves as readable progress. No URL and no LinkedIn opaque value may be in it (uploadState.ts). */
interface LinkedInMultipartData {
  asset: string;
  mediaArtifact: string;
  totalBytes: number;
  partCount: number;
  /** Index of the next part to send; `etags[i]` is the ETag of part `i`. */
  nextPart: number;
  etags: string[];
  phase: "upload" | "processing";
  /** Epoch ms the completion was accepted: the clock of the wait for the asset. */
  completedAt?: number;
  /** The earliest `urlExpiresAt` of the parts (epoch ms). */
  urlsExpireAt: number;
  /** How many times the upload started over because its URLs were about to expire. */
  restarts: number;
  /** The last readable "not ready yet" status of the asset (processing phase only); absent when none, or an unknown one, was seen. */
  lastStatus?: LinkedInWaitingStatus;
}

/** What a step saves sealed: capability values. Present until the upload is completed. */
interface LinkedInMultipartSecret {
  parts: LinkedInUploadPart[];
  metadata: string;
}

/** An upload that has been registered on LinkedIn: where it stands, and (until completed) how to reach it. */
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

/** The part URLs are sent the video, so they must be https URLs. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** `urn:li:digitalmediaAsset:<id>`; the id is what `GET /assets/{id}` takes. */
const ASSET_URN = /^urn:li:digitalmediaAsset:([\w-]+)$/;

/** The headers LinkedIn asked for on a part, without any Authorization: the page says a video upload "shouldn't include an OAuth token". */
function readPartHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(asRecord(raw) ?? {})) {
    if (typeof value === "string" && name.toLowerCase() !== "authorization") headers[name] = value;
  }
  return headers;
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

/**
 * The upload LinkedIn registered, from the answer to `registerUpload`: the asset, the media
 * artifact and `metadata`, and the parts (`partUploadRequests`) sorted into byte order. Anything
 * unusable is LINKEDIN_VIDEO_UPLOAD_FAILED, before a byte is sent. A part larger than
 * LARGE_UPLOAD_MAX_PART_BYTES is refused here, before the first PUT: it is the memory bound.
 */
function readMultipartRegistration(body: unknown, totalBytes: number): LinkedInMultipartSession {
  const unusable = () =>
    uploadFailed("LinkedIn didn't return a usable multipart upload for this video. Nothing was posted.");

  const value = asRecord(asRecord(body)?.value);
  const mechanism = asRecord(asRecord(value?.uploadMechanism)?.[LINKEDIN_MULTIPART_MECHANISM]);
  const requests = mechanism?.partUploadRequests;
  const asset = value?.asset;
  const mediaArtifact = value?.mediaArtifact;
  const metadata = mechanism?.metadata;
  if (
    !Array.isArray(requests) ||
    typeof asset !== "string" ||
    !ASSET_URN.test(asset) ||
    !isText(mediaArtifact) ||
    !isText(metadata)
  ) {
    throw unusable();
  }

  const parts: LinkedInUploadPart[] = [];
  let urlsExpireAt = Number.POSITIVE_INFINITY;
  for (const request of requests) {
    const part = asRecord(request);
    const range = asRecord(part?.byteRange);
    if (
      !part ||
      !range ||
      !isHttpsUrl(part.url) ||
      !isWholeNumber(range.firstByte) ||
      !isWholeNumber(range.lastByte) ||
      !isFiniteNumber(part.urlExpiresAt)
    ) {
      throw unusable();
    }
    parts.push({
      url: part.url,
      firstByte: range.firstByte,
      lastByte: range.lastByte,
      headers: readPartHeaders(part.headers),
    });
    urlsExpireAt = Math.min(urlsExpireAt, part.urlExpiresAt);
  }
  parts.sort((a, b) => a.firstByte - b.firstByte);
  const problem = partsProblem(parts, totalBytes);
  if (problem !== null) throw uploadFailed(problem);

  return {
    data: {
      asset,
      mediaArtifact,
      totalBytes,
      partCount: parts.length,
      nextPart: 0,
      etags: [],
      phase: "upload",
      urlsExpireAt,
      restarts: 0,
    },
    secret: { parts, metadata },
  };
}

/**
 * The saved upload, if it can be used for a video of `totalBytes`: its asset, position, ETags,
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
  const { asset, mediaArtifact, partCount, nextPart, etags, phase, completedAt, urlsExpireAt, restarts } = data;

  if (typeof asset !== "string" || !ASSET_URN.test(asset) || !isText(mediaArtifact)) return null;
  if (data.totalBytes !== totalBytes) return null;
  if (!isWholeNumber(partCount) || partCount < 1) return null;
  if (!isWholeNumber(nextPart) || nextPart < 0 || nextPart > partCount) return null;
  if (!Array.isArray(etags) || etags.length !== nextPart || !etags.every(isText)) return null;
  if (phase !== "upload" && phase !== "processing") return null;
  if (!isFiniteNumber(urlsExpireAt) || !isWholeNumber(restarts) || restarts < 0) return null;

  const common = { asset, mediaArtifact, totalBytes, partCount, nextPart, etags: [...etags], urlsExpireAt, restarts };

  if (phase === "processing") {
    // The completion comes after the last part, and stamps its time. Nothing sealed is needed any more.
    if (nextPart !== partCount || !isFiniteNumber(completedAt)) return null;
    const lastStatus = asWaitingStatus(data.lastStatus);
    return {
      data: { ...common, phase, completedAt, ...(lastStatus === undefined ? {} : { lastStatus }) },
      secret: null,
    };
  }

  const secret = saved?.secret;
  if (!isText(secret?.metadata) || !Array.isArray(secret.parts) || secret.parts.length !== partCount) return null;
  const parts: LinkedInUploadPart[] = [];
  for (const raw of secret.parts) {
    const part = asRecord(raw);
    if (!part || !isHttpsUrl(part.url) || !isWholeNumber(part.firstByte) || !isWholeNumber(part.lastByte)) return null;
    parts.push({
      url: part.url,
      firstByte: part.firstByte,
      lastByte: part.lastByte,
      headers: readPartHeaders(part.headers),
    });
  }
  if (partsProblem(parts, totalBytes) !== null) return null;
  return { data: { ...common, phase }, secret: { parts, metadata: secret.metadata } };
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
 * `POST /v2/assets?action=registerUpload` as a MULTIPART_UPLOAD for a video of `totalBytes`: the
 * asset, the media artifact and the parts LinkedIn wants, as a fresh session at part 0. The call
 * commits nothing. A 429 is RATE_LIMITED, a 401 goes through the guarded reconnect flag, and any
 * other error status is LINKEDIN_VIDEO_UPLOAD_FAILED (carrying its `status`).
 */
async function registerMultipartUpload(args: {
  accessToken: string;
  ownerUrn: string;
  totalBytes: number;
  connection: TokenSnapshot;
  deadline: number | undefined;
}): Promise<LinkedInMultipartSession> {
  const { accessToken, ownerUrn, totalBytes, connection, deadline } = args;

  const response = await fetchWithTimeout(
    `${LINKEDIN_ASSETS_URL}?action=registerUpload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: [LINKEDIN_VIDEO_RECIPE],
          owner: ownerUrn,
          serviceRelationships: [
            {
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            },
          ],
          supportedUploadMechanism: ["MULTIPART_UPLOAD"],
          fileSize: totalBytes,
        },
      }),
    },
    budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
  );

  const limited = await classifyRateLimit("linkedin", response);
  if (limited) throw limited;
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    await throwLinkedInReconnect(connection);
  }
  // MULTIPART_UPLOAD below the 200 MB the page names is unconfirmed (see above), so a refusal
  // here is a failed upload, like the other unconfirmed calls.
  await assertOk(response, {
    code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
    prefix: "LinkedIn multipart upload registration failed",
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw uploadFailed("LinkedIn didn't return a usable multipart upload for this video. Nothing was posted.");
  }
  return readMultipartRegistration(body, totalBytes);
}

/** What a status check says about the asset. A processing failure is thrown, not returned. */
type AssetVerdict =
  | { kind: "available" }
  /** Not ready yet. `status` is the recipe's status when it is one the page lists, else undefined. */
  | { kind: "waiting"; status: LinkedInWaitingStatus | undefined }
  /** An answer we cannot use: a 404, a body that is not JSON, or no `feedshare-video` recipe in it. */
  | { kind: "unreadable"; reason: string }
  /** No answer: a 5xx, a timeout, or a connection that dropped. Asking again is safe. */
  | { kind: "unanswered" };

/** The recipe statuses that mean LinkedIn stopped without an asset. */
const LINKEDIN_RECIPE_FAILED_STATUSES: ReadonlySet<string> = new Set(["CLIENT_ERROR", "SERVER_ERROR", "INCOMPLETE"]);

/**
 * `GET /v2/assets/{id}` (the id is the part of the asset URN after the last colon): the status of
 * the `feedshare-video` recipe. AVAILABLE is ready; CLIENT_ERROR, SERVER_ERROR and INCOMPLETE are
 * LINKEDIN_VIDEO_PROCESSING_FAILED; every other status, one we do not know included, is still
 * processing. It only reads, so it is safe to ask again. A 401 goes through the guarded reconnect
 * flag, a 429 is RATE_LIMITED, and any other error status is LINKEDIN_VIDEO_UPLOAD_FAILED, apart
 * from a 404, which is "unreadable" (the unconfirmed /v2 status read may simply not exist).
 */
async function checkAssetStatus(args: {
  accessToken: string;
  asset: string;
  connection: TokenSnapshot;
  deadline: number | undefined;
}): Promise<AssetVerdict> {
  const { accessToken, asset, connection, deadline } = args;
  const assetId = asset.slice(asset.lastIndexOf(":") + 1);

  const attempt = await attemptRequest(() =>
    fetchWithTimeout(
      `${LINKEDIN_ASSETS_URL}/${encodeURIComponent(assetId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
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

  const recipes = asRecord(body)?.recipes;
  const recipe = Array.isArray(recipes)
    ? recipes.map(asRecord).find((candidate) => candidate?.recipe === LINKEDIN_VIDEO_RECIPE)
    : undefined;
  const status = recipe?.status;
  if (typeof status !== "string") {
    return { kind: "unreadable", reason: "the status answer has no feedshare-video recipe status" };
  }
  if (status === "AVAILABLE") return { kind: "available" };
  if (LINKEDIN_RECIPE_FAILED_STATUSES.has(status)) {
    console.error("[LinkedIn] Video processing failed", { assetUrn: asset, recipeStatus: status });
    throw processingFailed();
  }
  return { kind: "waiting", status: asWaitingStatus(status) };
}

/**
 * One step of a multipart upload (2026-11-02 scale audit, jobs B3). Whether to start an upload or
 * resume one is decided by `resumed` alone - the state `load()` returned - and never by
 * `ctx.continuation`: if a step's output is lost after it continued, the same step number runs
 * again with the state already there and must resume, not register a second asset.
 *
 * Phases, each saved before the step moves on:
 * - none: `registerUpload` as a MULTIPART_UPLOAD, saved at once (before the first part).
 * - upload: parts from `nextPart`, each read from the blob with one Range request for the step and
 *   PUT, without a token, to its URL with its own headers, while at least
 *   LARGE_UPLOAD_CHUNK_WINDOW_MS of the step is left; the ETag of each is saved. Then
 *   `completeMultiPartUpload` with the ETags in part order, once; the sealed part URLs and
 *   metadata are dropped from the saved state, and the step continues after the poll interval.
 * - processing: one status check per step. AVAILABLE posts (ugcPosts, the commit call) in the
 *   same step, with at least LINKEDIN_POST_MIN_WINDOW_MS left, else the step continues at once;
 *   a failed recipe is LINKEDIN_VIDEO_PROCESSING_FAILED. A status that is not ready yet continues
 *   after LINKEDIN_ASSET_POLL_INTERVAL_MS and is saved as `lastStatus`; a missing answer (a 5xx,
 *   a timeout, a 404, a body we cannot read) continues after LINKEDIN_TRANSIENT_RESUME_DELAY_MS.
 *   At LINKEDIN_ASSET_MAX_WAIT_MS since the completion the post is made anyway (with a warning)
 *   only when LinkedIn's last readable status was PROCESSING - the whole-file path posts right
 *   after its upload - and anything else is LINKEDIN_VIDEO_UPLOAD_FAILED, before any post.
 *
 * With the earliest part URL expiring in under LINKEDIN_URL_EXPIRY_SAFETY_MS and parts left, the
 * video is registered again and uploaded from part 0 (nothing was posted), at most
 * LINKEDIN_MAX_UPLOAD_RESTARTS times. A part answered 403 is taken for an expired URL and
 * restarts the same way, in the next step, using the same count. A part, the completion, a status
 * check or the registration of a restart that gets no usable answer (5xx, timeout, dropped
 * connection) pauses for LINKEDIN_TRANSIENT_RESUME_DELAY_MS and is sent again in the next step
 * (a restart that is waiting for its registration is not counted twice); running into the step
 * deadline pauses too. A 429 saves the position, then throws RATE_LIMITED.
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
    const registered = await registerMultipartUpload({
      accessToken,
      ownerUrn: authorUrn,
      totalBytes,
      connection,
      deadline,
    });
    const session: LinkedInMultipartSession = { data: { ...registered.data, restarts }, secret: registered.secret };
    await save(session);
    console.log("[LinkedIn] Multipart upload registered", {
      assetUrn: session.data.asset,
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
      // Nothing was posted: the asset left behind is simply never used.
      if (progress.restarts >= LINKEDIN_MAX_UPLOAD_RESTARTS) {
        throw uploadFailed(
          "LinkedIn's upload links kept expiring before the video was uploaded. Nothing was posted — please retry.",
        );
      }
      if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
      console.warn("[LinkedIn] The upload links are about to expire; registering the video again", {
        assetUrn: progress.asset,
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
          // Reading runs into the deadline: nothing was sent, so this is not a failure of the
          // upload. The next step reopens the blob at the same part.
          if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
          throw error;
        }
        // Reading takes time too: the part must still fit.
        if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);

        const attempt = await attemptRequest(() =>
          fetchWithTimeout(
            part.url,
            // No Authorization: the page says a video upload "shouldn't include an OAuth token".
            { method: "PUT", headers: part.headers, body },
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
        if (response.status === 403 && current.data.restarts < LINKEDIN_MAX_UPLOAD_RESTARTS) {
          // A part URL that is refused is taken for an expired one. Nothing was posted. The next
          // step starts over exactly as it does for a URL that is about to expire (and counts it,
          // and stops at the same cap): this step only records that the URLs are spent.
          console.warn("[LinkedIn] A part was refused with 403; the upload links are taken for expired", {
            part: index + 1,
            parts: partCount,
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
        const etag = response.headers.get("ETag");
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

      // The completion commits nothing yet (the post does), so it starts with a full window left.
      if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
      const attempt = await attemptRequest(() =>
        fetchWithTimeout(
          `${LINKEDIN_ASSETS_URL}?action=completeMultiPartUpload`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "X-Restli-Protocol-Version": "2.0.0",
            },
            body: JSON.stringify({
              completeMultipartUploadRequest: {
                mediaArtifact: current.data.mediaArtifact,
                metadata: secret.metadata,
                partUploadResponses: current.data.etags.map((etag) => ({
                  headers: { ETag: etag },
                  httpStatusCode: 200,
                })),
              },
            }),
          },
          budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
        ),
      );
      if ("failure" in attempt) {
        if (!isTransientUploadFailure(attempt.failure)) throw attempt.failure;
        console.warn("[LinkedIn] The completion got no answer; the next step asks again", {
          status: (attempt.failure as { status?: unknown } | null)?.status,
          code: (attempt.failure as { code?: unknown } | null)?.code,
        });
        return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
      }
      if (attempt.response.status === 401) {
        void attempt.response.body?.cancel().catch(() => {});
        await throwLinkedInReconnect(connection);
      }
      // An unconfirmed endpoint (see above): a refusal is a failed upload, before any post. The
      // body is neither read nor logged (not assertOk): logs become Sentry breadcrumbs, and
      // LinkedIn's text could quote the `metadata` it was sent.
      void attempt.response.body?.cancel().catch(() => {});
      if (!attempt.response.ok) {
        const status = attempt.response.status;
        console.error("[LinkedIn] The completion was refused", { status });
        throw uploadFailed(`LinkedIn video upload could not be completed (status ${status})`, status);
      }

      // The part URLs and the metadata are no longer needed: the saved state drops them.
      current = { data: { ...current.data, phase: "processing", completedAt: Date.now() }, secret: null };
      console.log("[LinkedIn] Multipart upload completed; waiting for the asset", {
        assetUrn: current.data.asset,
        parts: current.data.partCount,
      });
      return await pause(LINKEDIN_ASSET_POLL_INTERVAL_MS);
    }

    // processing: one status check, then the post.
    if (remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS) return await pause(null);
    const waitOver = Date.now() - (current.data.completedAt ?? Date.now()) >= LINKEDIN_ASSET_MAX_WAIT_MS;
    const verdict = await checkAssetStatus({ accessToken, asset: current.data.asset, connection, deadline });

    if (verdict.kind === "waiting") {
      // The last readable status: a status the page lists is remembered, one nobody documented is not.
      const readable = { ...current.data };
      if (verdict.status === undefined) delete readable.lastStatus;
      else readable.lastStatus = verdict.status;
      current = { ...current, data: readable };

      if (!waitOver) return await pause(LINKEDIN_ASSET_POLL_INTERVAL_MS);
      // Still PROCESSING at the cap is posted, as the whole-file path posts right after its upload.
      // WAITING_UPLOAD, NEW, MUTATING or a status nobody documented says LinkedIn never took the
      // upload, and nothing is posted.
      if (verdict.status !== "PROCESSING") {
        console.error("[LinkedIn] The video was never taken up by LinkedIn before the wait ran out", {
          assetUrn: current.data.asset,
          recipeStatus: verdict.status ?? "unknown",
        });
        throw uploadFailed("LinkedIn never started processing the uploaded video. Nothing was posted — please retry.");
      }
      console.warn("[LinkedIn] The video is still processing after the wait; posting anyway", {
        assetUrn: current.data.asset,
      });
    } else if (verdict.kind === "unanswered" || verdict.kind === "unreadable") {
      // No usable answer (a 5xx, a timeout, a dropped connection, a 404, a body we cannot read):
      // ask again soon, and at the cap post only if LinkedIn last said PROCESSING - the endpoint
      // then demonstrably works, and the asset is on its way. Otherwise the unconfirmed /v2 status
      // read never worked, and nothing is posted.
      if (!waitOver) {
        console.warn("[LinkedIn] The status check got no usable answer; the next step asks again", {
          assetUrn: current.data.asset,
          reason: verdict.kind === "unreadable" ? verdict.reason : "no answer",
        });
        return await pause(LINKEDIN_TRANSIENT_RESUME_DELAY_MS);
      }
      if (current.data.lastStatus !== "PROCESSING") {
        console.error("[LinkedIn] The status checks never gave a usable answer before the wait ran out", {
          assetUrn: current.data.asset,
        });
        throw uploadFailed(
          "LinkedIn's status checks never gave a usable answer. Nothing was posted — please retry.",
        );
      }
      console.warn("[LinkedIn] The status checks got no usable answer for the rest of the wait; posting anyway", {
        assetUrn: current.data.asset,
      });
    }

    // The post is the commit call: it starts with its whole timeout left, and finishes in this step.
    if (remainingMs(deadline) < LINKEDIN_POST_MIN_WINDOW_MS) return await pause(null);
    const postId = await createPost(accessToken, authorUrn, caption, connection, current.data.asset, true, deadline);
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
    // the whole-file upload below, unchanged. The saved state alone decides whether this step
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
        // uploadVideo now uses Assets API with UGC service relationship (like images)
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
