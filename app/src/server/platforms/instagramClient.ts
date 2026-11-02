import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";
import { markConnectionNeedsReconnect } from "./connectionHealth";
import { isFacebookAuthErrorBody } from "./facebookPageClient";
import { commitRequest } from "./commitCall";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";

// COR-5: Instagram token expiry handling.
//
// Token-material reality (see app/src/app/api/auth/instagram/callback/route.ts):
// the connection's `accessToken` is a long-lived Facebook PAGE access token
// (minted from a long-lived user token during OAuth) and `refreshToken` is
// stored as null. Page tokens derived from a long-lived user token carry no
// refresh token and generally do not expire on a fixed clock, but they CAN be
// invalidated (the user revokes access / changes password, or the parent
// long-lived user token lapses). The stored `expiresAt` mirrors that user
// token's ~60-day window and is used here as a conservative "time to prompt
// reconnect" signal.
//
// There is deliberately NO refresh call: `fb_exchange_token` re-extends USER
// tokens, not page tokens, and no user token is stored — so the only real
// recovery is to reconnect. The fix is therefore an expiry check on the token
// actually used for publishing, surfaced as a clean, coded reconnect error.

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // treat tokens within 5 min of expiry as expired
// Roadmap Phase 4: the code marked via markConnectionNeedsReconnect() at every
// site below that throws this error (expiry guard + 401 mapping).
const INSTAGRAM_RECONNECT_CODE = "INSTAGRAM_RECONNECT_REQUIRED";

// 2026-11-01 scale audit (step budget, Task 7): the container poll runs INSIDE
// the publish step, which must end by ctx.deadline (publishBudget.ts, 225 s of
// Vercel's 300 s). Today it polls every 5 s, up to 30 times (~150 s, plus each
// check's own time); Meta's guidance is once a minute for at most 5 minutes
// (https://developers.facebook.com/docs/instagram-platform/content-publishing),
// which needs polling across steps with step.sleep - phase 3, not this task.
export const INSTAGRAM_POLL_INTERVAL_MS = 5_000;
export const INSTAGRAM_POLL_MAX_ATTEMPTS = 30;
/**
 * Time kept free after the poll for the media_publish call (a 30 s request,
 * clamped to what is left). The poll stops while this much is still left and
 * ends with INSTAGRAM_VIDEO_TIMEOUT: nothing was published at that point, so a
 * retry is safe.
 */
export const INSTAGRAM_PUBLISH_RESERVE_MS = 20_000;

function isExpiredOrExpiringSoon(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false; // no expiry recorded -> cannot judge; let publish proceed
  return new Date(expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS;
}

function instagramReconnectRequiredError(cause?: unknown): Error & { code: string } {
  const error = new Error(
    "Your Instagram connection has expired — please reconnect it in Settings.",
  ) as Error & { code: string };
  error.code = INSTAGRAM_RECONNECT_CODE;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Did the Graph API reject the page token itself? HTTP 401, or — the common
 * case — an `OAuthException` with code 190 (invalid/expired token), which
 * Facebook usually sends with HTTP 400. Same detection as facebookPageClient.ts
 * (shared, not duplicated): both publish through the same Graph API.
 */
function isGraphAuthFailure(status: number, body: string): boolean {
  return status === 401 || isFacebookAuthErrorBody(body);
}

/**
 * Guard the token before hitting the Graph API. Instagram cannot refresh (see
 * file header), so an expired/near-expired token becomes a clean, actionable
 * reconnect error instead of a raw OAuth failure surfaced to the user via
 * PostJobResult.errorMessage. Returns the connection unchanged when usable.
 * Exported for unit tests.
 */
export function ensureFreshInstagramToken(
  connection: SocialConnection,
): SocialConnection {
  if (isExpiredOrExpiringSoon(connection.expiresAt)) {
    throw instagramReconnectRequiredError();
  }
  return connection;
}

/**
 * Apply Instagram's caption limit (2,200 characters) the same way the preview
 * does, reading the number from the shared `platformLimits.ts` map. Instagram
 * rejects a longer caption outright, so without this an over-long caption
 * failed the whole publish (2026-11-01 audit). Extracted as a pure, exported
 * function so it can be asserted without mocking the Graph API.
 */
export function computeInstagramCaption(caption: string): string {
  const { charLimit, ellipsis } = PLATFORM_CAPTION_LIMITS.instagram;
  // instagram's charLimit is always a number (see platformLimits.ts); the null
  // check only exists to satisfy the shared `Record<Platform, ...>` type.
  return charLimit === null ? caption : truncateGraphemes(caption, charLimit, { ellipsis });
}

export interface WaitForInstagramContainerOptions {
  containerId: string;
  accessToken: string;
  /** Flagged needsReconnect if the status check shows the page token is dead. */
  connectionId: string;
  /** The step deadline (epoch ms): polling stops with INSTAGRAM_PUBLISH_RESERVE_MS still left before it. */
  deadline?: number;
  /** Test seam: defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Poll a REELS container until Instagram has processed the video (FINISHED).
 * Resolves only then; every other outcome throws:
 *  - ERROR -> `INSTAGRAM_VIDEO_PROCESSING_ERROR`
 *  - a dead page token (401 / OAuthException 190) -> `INSTAGRAM_RECONNECT_REQUIRED`
 *    (connection flagged)
 *  - a Meta throttle -> RATE_LIMITED (polling again would only extend the limit)
 *  - still processing after INSTAGRAM_POLL_MAX_ATTEMPTS checks, or when the step
 *    `deadline` leaves no room for another wait + check before the
 *    INSTAGRAM_PUBLISH_RESERVE_MS kept for media_publish -> `INSTAGRAM_VIDEO_TIMEOUT`.
 *    Nothing has been published at that point, so a retry is safe.
 * Any other non-OK status is treated as transient and polled again. Each status
 * request is clamped to the time left BEFORE the reserve, so a slow check cannot
 * eat the media_publish window.
 */
export async function waitForInstagramContainer(
  options: WaitForInstagramContainerOptions,
): Promise<void> {
  const {
    containerId,
    accessToken,
    connectionId,
    deadline,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;

  // Time the poll may still use: what is left of the step minus the reserve.
  // Unbounded (Infinity) without a deadline.
  const pollWindowMs = () => remainingMs(deadline, now()) - INSTAGRAM_PUBLISH_RESERVE_MS;

  for (let attempt = 0; attempt < INSTAGRAM_POLL_MAX_ATTEMPTS; attempt++) {
    // Only wait + check when both fit before the reserve (the check needs a
    // usable request window).
    if (pollWindowMs() < INSTAGRAM_POLL_INTERVAL_MS + MIN_REQUEST_WINDOW_MS) break;
    await sleep(INSTAGRAM_POLL_INTERVAL_MS);
    // A wait that overran leaves no usable window for the check.
    const checkWindowMs = pollWindowMs();
    if (checkWindowMs < MIN_REQUEST_WINDOW_MS) break;

    const statusUrl = new URL(`https://graph.facebook.com/v21.0/${containerId}`);
    statusUrl.searchParams.set("fields", "status_code");
    statusUrl.searchParams.set("access_token", accessToken);

    const statusResponse = await fetchWithTimeout(
      statusUrl.toString(),
      undefined,
      Math.min(DEFAULT_FETCH_TIMEOUT_MS, checkWindowMs),
    );
    // A throttled poll stops here; polling again would only extend the limit.
    const statusLimited = await classifyRateLimit("instagram", statusResponse);
    if (statusLimited) throw statusLimited;

    if (!statusResponse.ok) {
      const statusBody = await statusResponse.text().catch(() => "");
      // A dead token never recovers by polling: stop and ask for a
      // reconnect. Any other non-OK status is treated as transient and
      // polled again (unchanged behavior).
      if (isGraphAuthFailure(statusResponse.status, statusBody)) {
        console.error("[Instagram] Status check rejected the access token", {
          status: statusResponse.status,
          error: statusBody,
        });
        await markConnectionNeedsReconnect(connectionId, INSTAGRAM_RECONNECT_CODE);
        throw instagramReconnectRequiredError();
      }
    } else {
      const statusData = (await statusResponse.json()) as {
        status_code?: string;
      };

      console.log("[Instagram] Video status:", statusData.status_code);

      if (statusData.status_code === "FINISHED") return;
      if (statusData.status_code === "ERROR") {
        const error = new Error("Instagram video processing failed") as Error & { code: string };
        error.code = "INSTAGRAM_VIDEO_PROCESSING_ERROR";
        throw error;
      }
    }
  }

  const error = new Error("Instagram video processing timeout") as Error & { code: string };
  error.code = "INSTAGRAM_VIDEO_TIMEOUT";
  throw error;
}

export const instagramClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, caption, deadline } = ctx;

    // COR-5: fail fast with a clear reconnect error if the page token has
    // aged out, rather than letting the Graph API return a cryptic OAuth error.
    // Roadmap Phase 4: mark needsReconnect before the guard's error
    // propagates (see connectionHealth.ts).
    try {
      socialConnection = ensureFreshInstagramToken(socialConnection);
    } catch (error) {
      await markConnectionNeedsReconnect(socialConnection.id, INSTAGRAM_RECONNECT_CODE);
      throw error;
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for Instagram") as Error & { code: string };
      error.code = "INSTAGRAM_NO_ACCESS_TOKEN";
      throw error;
    }

    const metadata = (socialConnection.metadata as { username?: string } | null) || {};
    const igAccountId = socialConnection.accountIdentifier;

    if (!igAccountId) {
      const error = new Error("Missing Instagram account ID") as Error & { code: string };
      error.code = "INSTAGRAM_NO_ACCOUNT_ID";
      throw error;
    }

    console.log("[Instagram] Starting media upload", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
      igAccountId,
    });

    const mediaUrl = mediaItem.storageLocation;
    const isVideo = mediaItem.mimeType?.startsWith("video/");

    // Parse location from metadata if available
    const locationMetadata = (mediaItem.metadata as { location?: { description?: string } } | null)?.location;
    let locationId: string | undefined;

    if (locationMetadata?.description) {
      const locStr = locationMetadata.description.trim();
      const coordMatch = locStr.match(/\((-?\d+\.?\d*),\s*(-?\d+\.?\d*)\)/);

      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);

        console.log("[Instagram] Location coordinates found", { lat, lng });
        // Note: Instagram Graph API requires a Facebook Place ID, not just coordinates
        // For now, we'll skip location. To add it, you'd need to search Facebook Places API
        // with these coordinates to get a location_id
      }
    }

    try {
      // Step 1: Create media container
      const containerUrl = new URL(`https://graph.facebook.com/v21.0/${igAccountId}/media`);
      
      const containerParams: Record<string, string> = {
        access_token: accessToken,
        caption: computeInstagramCaption(caption),
      };

      if (isVideo) {
        // Instagram now requires REELS for video posts (VIDEO is deprecated)
        containerParams.media_type = "REELS";
        containerParams.video_url = mediaUrl;
      } else {
        containerParams.image_url = mediaUrl;
      }

      if (locationId) {
        containerParams.location_id = locationId;
      }

      Object.entries(containerParams).forEach(([key, value]) => {
        containerUrl.searchParams.set(key, value);
      });

      console.log("[Instagram] Creating media container", {
        mediaType: isVideo ? "REELS" : "IMAGE",
        hasLocation: !!locationId,
      });

      // Every request below ends by the step deadline and none is started with
      // under 5 s left: PUBLISH_TIME_BUDGET_EXCEEDED, nothing sent (Task 7).
      const containerResponse = await fetchWithTimeout(
        containerUrl.toString(),
        { method: "POST" },
        budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
      );

      // 2026-11-01 scale audit (platform limits): a Meta throttle (code 4, 17,
      // 32, 613, 80001, 80002 or HTTP 429) is RATE_LIMITED, not a container failure.
      const containerLimited = await classifyRateLimit("instagram", containerResponse);
      if (containerLimited) throw containerLimited;

      if (!containerResponse.ok) {
        const errorBody = await containerResponse.text().catch(() => "Unable to read error body");
        console.error("[Instagram] Container creation failed", {
          status: containerResponse.status,
          error: errorBody,
        });
        // COR-5: the page token is no longer accepted (401, or an
        // OAuthException 190 on any status) — map it to the actionable
        // reconnect error instead of leaking the raw body.
        if (isGraphAuthFailure(containerResponse.status, errorBody)) {
          // Roadmap Phase 4: mark before throwing (see connectionHealth.ts).
          await markConnectionNeedsReconnect(socialConnection.id, INSTAGRAM_RECONNECT_CODE);
          throw instagramReconnectRequiredError();
        }
        // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
        const error = new Error(
          `Instagram container creation failed (status ${containerResponse.status})`,
        ) as Error & { code: string };
        error.code = "INSTAGRAM_CONTAINER_FAILED";
        throw error;
      }

      const containerData = (await containerResponse.json()) as {
        id: string;
      };

      const containerId = containerData.id;

      console.log("[Instagram] Container created", { containerId });

      // Step 2: Wait for media processing
      if (isVideo) {
        console.log("[Instagram] Waiting for video processing...");

        // Bounded by the step deadline: stops with INSTAGRAM_VIDEO_TIMEOUT while
        // INSTAGRAM_PUBLISH_RESERVE_MS is still left for media_publish.
        await waitForInstagramContainer({
          containerId,
          accessToken,
          connectionId: socialConnection.id,
          deadline,
        });

        console.log("[Instagram] Video processing complete");
      } else {
        // For images, wait a brief moment for Instagram to process
        console.log("[Instagram] Waiting for image processing...");
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
      }

      // Step 3: Publish the container
      const publishUrl = new URL(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`);
      publishUrl.searchParams.set("creation_id", containerId);
      publishUrl.searchParams.set("access_token", accessToken);

      console.log("[Instagram] Publishing media container");

      // 2026-11-01 scale audit (jobs H6, Review Focus 5): media_publish is the
      // commit call. A 5xx, a timeout or a dropped connection after it was sent
      // is PUBLISH_UNCONFIRMED (the post may be live) and is never re-run; a
      // 4xx / 429 is returned and handled below as before. The timeout is clamped
      // to the remaining step budget; a spent budget throws
      // PUBLISH_TIME_BUDGET_EXCEEDED BEFORE the request is sent (safe to retry).
      const publishResponse = await commitRequest("instagram", () =>
        fetchWithTimeout(
          publishUrl.toString(),
          { method: "POST" },
          budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline),
        ),
      );

      // Includes code 9 / subcode 2207042: the 100-posts-per-24h publishing cap.
      const publishLimited = await classifyRateLimit("instagram", publishResponse);
      if (publishLimited) throw publishLimited;

      if (!publishResponse.ok) {
        const errorBody = await publishResponse.text().catch(() => "Unable to read error body");
        console.error("[Instagram] Publish failed", {
          status: publishResponse.status,
          error: errorBody,
        });
        // COR-5: token no longer valid (401, or OAuthException 190 on any
        // status) -> ask for reconnect.
        if (isGraphAuthFailure(publishResponse.status, errorBody)) {
          // Roadmap Phase 4: mark before throwing (see connectionHealth.ts).
          await markConnectionNeedsReconnect(socialConnection.id, INSTAGRAM_RECONNECT_CODE);
          throw instagramReconnectRequiredError();
        }
        // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
        const error = new Error(
          `Instagram publish failed (status ${publishResponse.status})`,
        ) as Error & { code: string };
        error.code = "INSTAGRAM_PUBLISH_FAILED";
        throw error;
      }

      const publishData = (await publishResponse.json()) as {
        id: string;
      };

      const mediaId = publishData.id;

      console.log("[Instagram] Media published successfully", {
        mediaId,
        username: metadata.username,
      });

      return {
        externalPostId: mediaId,
      };
    } catch (error: unknown) {
      console.error("[Instagram] Publish error", error);
      throw error;
    }
  },

  async refreshToken(connection: SocialConnection): Promise<SocialConnection> {
    // Instagram page tokens cannot be refreshed (see file header). Delegate to
    // the same guard used at publish time so any future caller gets correct
    // behavior — a fresh connection or a coded reconnect error — not a silent
    // no-op that hides an expired token.
    try {
      return ensureFreshInstagramToken(connection);
    } catch (error) {
      // Roadmap Phase 4: mark before throwing (see connectionHealth.ts).
      await markConnectionNeedsReconnect(connection.id, INSTAGRAM_RECONNECT_CODE);
      throw error;
    }
  },
};
