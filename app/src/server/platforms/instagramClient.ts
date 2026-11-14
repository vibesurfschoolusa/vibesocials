import type { PlatformClient, PublishContext, PublishResult } from "./types";
import type { SocialConnection } from "@prisma/client";

import { altTextOf } from "@/lib/altText";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { truncateGraphemes } from "@/lib/truncate";
import type { UploadStateStore } from "@/server/jobs/uploadState";
import {
  connectionTokenChangedError,
  flagRejectedToken,
  flagTerminalRefreshFailure,
  type TokenSnapshot,
} from "./connectionHealth";
import { isFacebookAuthErrorBody } from "./facebookPageClient";
import {
  commitRequest,
  publishUnconfirmedError,
  readCommitBody,
  requireCommitId,
} from "./commitCall";
import { budgetedTimeout, MIN_REQUEST_WINDOW_MS, remainingMs } from "./publishBudget";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { MULTI_PHOTO_MIME_TYPES } from "@/lib/postMedia";
import type { PostCover } from "@/lib/videoCover";
import { instagramImageUrl } from "./instagramPhoto";
import { classifyRateLimit } from "./rateLimited";

/**
 * 07d: IG User Media reference (read 2026-11-10,
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media):
 * `alt_text` is "Alternative text, up to 1000 character, for an image", "for image
 * posts only", on "a single image or image media in a carousel"; "Reels and stories
 * are not supported".
 */
const INSTAGRAM_ALT_TEXT_LIMIT = 1000;

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
// Roadmap Phase 4: the code flagged (flagRejectedToken / flagTerminalRefreshFailure)
// at every site below that throws this error (expiry guard + 401 mapping).
const INSTAGRAM_RECONNECT_CODE = "INSTAGRAM_RECONNECT_REQUIRED";

// 2026-11-02 scale audit (jobs L5): a REELS video is processed by Instagram
// after the container is created, and Meta recommends "querying a container's
// status once per minute, for no more than 5 minutes"
// (https://developers.facebook.com/docs/instagram-platform/content-publishing).
// That cannot happen inside one publish step (225 s of Vercel's 300 s,
// publishBudget.ts), so a step that is given an upload-state store (uploadState.ts)
// polls ACROSS steps:
//
//   step 1      creates the container, saves { containerId, createdAt, checks: 0 }
//               and continues in INSTAGRAM_STATUS_CHECK_INTERVAL_MS;
//   steps 2..6  each make ONE status check (a durable sleep before each, so the run
//               holds no concurrency slot while it waits): FINISHED goes on to
//               media_publish in that same claimed step; IN_PROGRESS (or an answer
//               that says nothing) counts the check and, below
//               INSTAGRAM_STATUS_MAX_CHECKS, continues.
//
// Nothing in the state is secret (a container id is not a capability: it cannot be
// used without the page token, which is never stored), so it is saved in plain
// `data`. The claim is released between steps and re-taken by the next one; the
// commit call (media_publish) and everything after it never cross a step boundary.
// Whether to create or to check is decided by the saved state alone (and its age),
// never by `ctx.continuation`: a step whose output was lost is re-run with the state
// already there and checks the same container instead of creating a second one.
//
// A container does not outlive a long wait: Meta discards one that is not published
// within 24 hours (EXPIRED). The state is therefore dropped when media_publish is
// refused for the daily publishing cap (a definitive refusal that defers the result by
// 24 h), and a saved container older than INSTAGRAM_CONTAINER_MAX_AGE_MS is replaced
// by a new one instead of being checked. Either way nothing was posted, so the
// deferred attempt just creates a fresh container.
/** The gap between two status checks, and so the wait before each one. */
export const INSTAGRAM_STATUS_CHECK_INTERVAL_MS = 60_000;
/** Status checks a container is given before the publish fails INSTAGRAM_VIDEO_TIMEOUT (nothing was published). */
export const INSTAGRAM_STATUS_MAX_CHECKS = 5;
/** The `kind` of the upload state a REELS publish saves between steps (uploadState.ts). */
export const INSTAGRAM_CONTAINER_STATE_KIND = "instagram_container";
/**
 * A saved container older than this is replaced, not checked. Meta reports EXPIRED for a
 * container "not published within 24 hours"
 * (https://developers.facebook.com/docs/instagram-platform/content-publishing); 23 h
 * leaves an hour of slack for clock differences and the wait before the next step.
 */
export const INSTAGRAM_CONTAINER_MAX_AGE_MS = 23 * 3_600_000;

// 2026-11-01 scale audit (step budget, Task 7): the in-step container poll, now
// used only when no upload-state store is given (a direct caller, a test), runs
// INSIDE the publish step, which must end by ctx.deadline. It polls every 5 s, up
// to 30 times (~150 s, plus each check's own time).
export const INSTAGRAM_POLL_INTERVAL_MS = 5_000;
export const INSTAGRAM_POLL_MAX_ATTEMPTS = 30;
/**
 * Time kept free after the in-step poll for the media_publish call (a 30 s
 * request, clamped to what is left). The poll stops while this much is still left
 * and ends with INSTAGRAM_VIDEO_TIMEOUT: nothing was published at that point, so
 * a retry is safe.
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
 * The page token was rejected: flag the connection and throw the actionable
 * reconnect error. The flag is guarded by the tokens the rejected call used
 * (2026-11-02 scale audit, jobs, token refresh): if another process changed them
 * since this publish read the row (the user reconnected), NOTHING is flagged and
 * the plain, retryable CONNECTION_TOKEN_CHANGED is thrown. Not for
 * instagramClient.refreshToken: a refresher flags through
 * flagTerminalRefreshFailure, which throws TOKEN_REFRESH_SUPERSEDED.
 */
async function throwInstagramReconnect(connection: TokenSnapshot): Promise<never> {
  if ((await flagRejectedToken(connection, INSTAGRAM_RECONNECT_CODE)) === "superseded") {
    throw connectionTokenChangedError();
  }
  throw instagramReconnectRequiredError();
}

/**
 * The expiry guard (ensureFreshInstagramToken) refused the stored `expiresAt`:
 * flag the connection, guarded by the tokens this publish read, and rethrow the
 * guard's reconnect error. Nothing was sent to Meta, but the row may be stale: if
 * the stored tokens changed since (the user reconnected), nothing is flagged and
 * the retryable CONNECTION_TOKEN_CHANGED is thrown instead.
 */
async function flagExpiredToken(connection: TokenSnapshot, guardError: unknown): Promise<never> {
  if ((await flagRejectedToken(connection, INSTAGRAM_RECONNECT_CODE)) === "superseded") {
    throw connectionTokenChangedError();
  }
  throw guardError;
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

function instagramCodedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** What one status check of a container told us. */
type ContainerStatus =
  /** FINISHED: Instagram has processed the video and the container can be published. */
  | "finished"
  /** IN_PROGRESS, or an answer that says nothing (a failed request, an unreadable body, an unknown status). */
  | "waiting";

/** One status request for a container. Rejects with the request's own error (a timeout, a dropped connection). */
function requestContainerStatus(options: {
  containerId: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<Response> {
  const statusUrl = new URL(`${META_GRAPH_BASE_URL}/${options.containerId}`);
  statusUrl.searchParams.set("fields", "status_code");
  statusUrl.searchParams.set("access_token", options.accessToken);
  return fetchWithTimeout(statusUrl.toString(), undefined, options.timeoutMs);
}

/**
 * Sort the answer to a status request (https://developers.facebook.com/docs/instagram-platform/content-publishing:
 * EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED). Resolves for the two answers a
 * poll goes on from; every other outcome throws:
 *  - ERROR -> `INSTAGRAM_VIDEO_PROCESSING_ERROR`
 *  - EXPIRED (not published within 24 hours) -> `INSTAGRAM_CONTAINER_EXPIRED`
 *  - PUBLISHED -> `PUBLISH_UNCONFIRMED`. Nothing in a status check publishes, so a
 *    container that is already PUBLISHED was published by something other than this
 *    check: possibly by an earlier try of ours. We cannot say what is live, and we
 *    do not call media_publish on it.
 *  - a Meta throttle -> RATE_LIMITED (polling again would only extend the limit)
 *  - a dead page token (401 / OAuthException 190) -> `INSTAGRAM_RECONNECT_REQUIRED`
 *    (connection flagged), or `CONNECTION_TOKEN_CHANGED` (nothing flagged) when
 *    the stored tokens are no longer the ones the request used
 * Any other non-OK status, and a body that cannot be read, is transient: "waiting".
 */
async function readContainerStatus(
  response: Response,
  connection: TokenSnapshot,
): Promise<ContainerStatus> {
  const limited = await classifyRateLimit("instagram", response);
  if (limited) throw limited;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // A dead token never recovers by polling: stop and ask for a reconnect.
    if (isGraphAuthFailure(response.status, body)) {
      console.error("[Instagram] Status check rejected the access token", {
        status: response.status,
        error: body,
      });
      await throwInstagramReconnect(connection);
    }
    return "waiting";
  }

  const data = (await response.json().catch(() => null)) as { status_code?: unknown } | null;
  const statusCode = data?.status_code;
  console.log("[Instagram] Video status:", statusCode);

  switch (statusCode) {
    case "FINISHED":
      return "finished";
    case "ERROR":
      throw instagramCodedError("INSTAGRAM_VIDEO_PROCESSING_ERROR", "Instagram video processing failed");
    case "EXPIRED":
      throw instagramCodedError(
        "INSTAGRAM_CONTAINER_EXPIRED",
        "Instagram discarded the video before it was published. Please retry.",
      );
    case "PUBLISHED":
      throw publishUnconfirmedError("instagram", new Error("Container was already PUBLISHED before our media_publish"));
    default:
      return "waiting";
  }
}

function instagramVideoTimeoutError(): Error & { code: string } {
  return instagramCodedError("INSTAGRAM_VIDEO_TIMEOUT", "Instagram video processing timeout");
}

export interface WaitForInstagramContainerOptions {
  containerId: string;
  accessToken: string;
  /**
   * The connection and the page token this poll sends. Flagged needsReconnect,
   * guarded by those tokens, if the status check shows the page token is dead.
   */
  connection: TokenSnapshot;
  /** The step deadline (epoch ms): polling stops with INSTAGRAM_PUBLISH_RESERVE_MS still left before it. */
  deadline?: number;
  /** Test seam: defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Poll a REELS container INSIDE one step until Instagram has processed the video
 * (FINISHED). This is the path for a caller with no upload-state store; a platform
 * step polls across steps instead (see the header). Resolves only on FINISHED;
 * every other outcome throws, as {@link readContainerStatus} lists, plus:
 *  - still processing after INSTAGRAM_POLL_MAX_ATTEMPTS checks, or when the step
 *    `deadline` leaves no room for another wait + check before the
 *    INSTAGRAM_PUBLISH_RESERVE_MS kept for media_publish -> `INSTAGRAM_VIDEO_TIMEOUT`.
 *    Nothing has been published at that point, so a retry is safe.
 * Each status request is clamped to the time left BEFORE the reserve, so a slow
 * check cannot eat the media_publish window.
 */
export async function waitForInstagramContainer(
  options: WaitForInstagramContainerOptions,
): Promise<void> {
  const {
    containerId,
    accessToken,
    connection,
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

    const response = await requestContainerStatus({
      containerId,
      accessToken,
      timeoutMs: Math.min(DEFAULT_FETCH_TIMEOUT_MS, checkWindowMs),
    });
    if ((await readContainerStatus(response, connection)) === "finished") return;
  }

  throw instagramVideoTimeoutError();
}

/** What a REELS publish saves between steps (kind {@link INSTAGRAM_CONTAINER_STATE_KIND}). Plain data: nothing is secret. */
interface InstagramContainerState {
  containerId: string;
  /** ISO instant the container was created. */
  createdAt: string;
  /** Status checks made so far (0 right after creation). */
  checks: number;
  /** V1: the chosen cover was refused, so the container was made without it. */
  coverRefused?: boolean;
}

/**
 * The saved container state, or null when there is none or it is not one we can
 * use. Unusable state is treated as absent: the publish starts over with a new
 * container, which is safe because nothing is published before media_publish.
 */
function readContainerState(data: unknown): InstagramContainerState | null {
  if (typeof data !== "object" || data === null) return null;
  const { containerId, createdAt, checks } = data as Record<string, unknown>;
  if (typeof containerId !== "string" || containerId.length === 0) return null;
  if (typeof checks !== "number" || !Number.isInteger(checks) || checks < 0) return null;
  const coverRefused = (data as Record<string, unknown>).coverRefused === true;
  return {
    containerId,
    createdAt: typeof createdAt === "string" ? createdAt : "",
    checks,
    ...(coverRefused ? { coverRefused } : {}),
  };
}

/**
 * Is the saved container too old to be worth checking? A `createdAt` that is missing or
 * cannot be read counts as stale: with no age to trust, a new container is the safe side
 * (nothing is published before media_publish). A future `createdAt` (clock skew) is not stale.
 */
function isStaleContainer(state: InstagramContainerState): boolean {
  const createdAt = Date.parse(state.createdAt);
  return Number.isNaN(createdAt) || Date.now() - createdAt > INSTAGRAM_CONTAINER_MAX_AGE_MS;
}

/**
 * Drop the saved container so the next step creates a new one. Best effort: the new
 * container's state overwrites it, and a stale one is detected again by its age, so a
 * failed clear must not fail a step that has nothing wrong with its publish.
 */
async function dropSavedContainer(store: UploadStateStore): Promise<void> {
  try {
    await store.clear();
  } catch (error) {
    console.warn("[Instagram] Could not clear the saved container state", {
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown } | null)?.code,
    });
  }
}

/** Ask the run to call this platform again once the next status check is due. */
function continueInAMinute(): PublishResult {
  return { continuation: { resumeAt: Date.now() + INSTAGRAM_STATUS_CHECK_INTERVAL_MS } };
}

/**
 * One status check of the container a previous step created. Returns null when it
 * is FINISHED (the caller publishes it, in this same step); otherwise counts the
 * check and either gives up (INSTAGRAM_VIDEO_TIMEOUT at INSTAGRAM_STATUS_MAX_CHECKS,
 * nothing was published, safe to retry) or saves the count and continues.
 *
 * A failed request (a timeout, a dropped connection) and any other answer that
 * says nothing count as a check: Meta's budget is five checks, not five answers.
 * A throttle is not counted: it throws RATE_LIMITED and the state is left as it was,
 * so the deferred attempt checks again.
 */
async function checkSavedContainer(args: {
  state: InstagramContainerState;
  accessToken: string;
  connection: TokenSnapshot;
  store: UploadStateStore;
  deadline: number | undefined;
}): Promise<PublishResult | null> {
  const { state, accessToken, connection, store, deadline } = args;

  // Before anything is sent, and outside the try below: a spent step budget is
  // retry-safe (PUBLISH_TIME_BUDGET_EXCEEDED), not a check.
  const timeoutMs = budgetedTimeout(DEFAULT_FETCH_TIMEOUT_MS, deadline);

  let response: Response | null = null;
  try {
    response = await requestContainerStatus({ containerId: state.containerId, accessToken, timeoutMs });
  } catch (error) {
    // Name and code only: a fetch error can quote the request URL, which carries the token.
    console.error("[Instagram] Status check did not complete; counting it as a check", {
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown } | null)?.code,
    });
  }

  const status = response ? await readContainerStatus(response, connection) : "waiting";
  if (status === "finished") {
    console.log("[Instagram] Video processing complete", {
      checks: state.checks + 1,
      createdAt: state.createdAt,
    });
    return null;
  }

  const checks = state.checks + 1;
  if (checks >= INSTAGRAM_STATUS_MAX_CHECKS) throw instagramVideoTimeoutError();

  await store.save<InstagramContainerState>(INSTAGRAM_CONTAINER_STATE_KIND, {
    data: { ...state, checks },
  });
  return continueInAMinute();
}

/**
 * Step 1 of a publish: create the media container. Returns its id. A throttle is
 * RATE_LIMITED, a dead page token is the guarded reconnect error, anything else
 * INSTAGRAM_CONTAINER_FAILED. Every request ends by the step deadline and none is
 * started with under 5 s left: PUBLISH_TIME_BUDGET_EXCEEDED, nothing sent.
 */
async function createInstagramContainer(args: {
  igAccountId: string;
  accessToken: string;
  connection: SocialConnection;
  caption: string;
  mediaUrl: string;
  isVideo: boolean;
  locationId?: string;
  deadline: number | undefined;
  /** A Story (2026-11-10) instead of a feed post. */
  story: boolean;
  /** 07d: the photo's description; sent for a feed photo only. */
  altText?: string;
  /** V1: a Reel's chosen cover; ignored for a photo and a Story. */
  cover?: PostCover;
}): Promise<string> {
  const { igAccountId, accessToken, connection, caption, mediaUrl, isVideo, locationId, deadline, story, altText, cover } =
    args;

  if (story) {
    // IG User Media reference (read 2026-11-10): a Story container takes
    // media_type=STORIES with image_url or video_url; caption is not among its
    // parameters, so none is sent. The photo is the app's JPEG copy that keeps its
    // shape (a Story is 9:16, which the feed crop would cut to 4:5).
    console.log("[Instagram] Creating media container", { mediaType: "STORIES", isVideo });
    return postInstagramContainer({
      igAccountId,
      params: {
        access_token: accessToken,
        media_type: "STORIES",
        ...(isVideo
          ? { video_url: mediaUrl }
          : { image_url: instagramImageUrl(mediaUrl, process.env.NEXTAUTH_URL, "story") }),
      },
      connection,
      deadline,
    });
  }

  const containerParams: Record<string, string> = {
    access_token: accessToken,
    caption: computeInstagramCaption(caption),
  };

  if (isVideo) {
    // Instagram now requires REELS for video posts (VIDEO is deprecated)
    containerParams.media_type = "REELS";
    containerParams.video_url = mediaUrl;
    // IG User Media reference (read 2026-11-14): `thumb_offset` is the frame in
    // milliseconds; `cover_url` is a public JPEG of 8 MB at most, and wins over
    // thumb_offset when both are sent. So a frame sends only its time (the
    // video's own frame, at full size) and an uploaded image only its URL.
    if (cover?.timeMs !== undefined) containerParams.thumb_offset = String(cover.timeMs);
    else if (cover?.imageUrl) containerParams.cover_url = cover.imageUrl;
  } else {
    // A JPEG copy cropped into Instagram's 4:5..1.91:1 range (instagramPhoto.ts);
    // the stored URL only when the app has no public address (local dev).
    containerParams.image_url = instagramImageUrl(mediaUrl, process.env.NEXTAUTH_URL);
    if (altText) containerParams.alt_text = altText;
  }

  if (locationId) {
    containerParams.location_id = locationId;
  }

  console.log("[Instagram] Creating media container", {
    mediaType: isVideo ? "REELS" : "IMAGE",
    hasLocation: !!locationId,
  });

  return postInstagramContainer({ igAccountId, params: containerParams, connection, deadline });
}

export const INSTAGRAM_COVER_REFUSED_NOTE =
  "Cover not set: Instagram did not accept the chosen cover, so the Reel uses its own.";

/**
 * A Reel's container with its cover (V1). Nothing is published before
 * media_publish, so a container refused with the cover is created once more
 * without it: a cover never fails the post. A throttle or a dead token is not
 * the cover's fault and is thrown as before.
 */
async function createContainerWithCover(
  args: Parameters<typeof createInstagramContainer>[0],
): Promise<{ containerId: string; coverRefused: boolean }> {
  const coverApplies = args.isVideo && !args.story && args.cover !== undefined;
  if (!coverApplies) {
    return { containerId: await createInstagramContainer({ ...args, cover: undefined }), coverRefused: false };
  }
  try {
    return { containerId: await createInstagramContainer(args), coverRefused: false };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "INSTAGRAM_CONTAINER_FAILED") throw error;
    console.warn("[Instagram] The container was refused with the cover; creating it without one");
    return { containerId: await createInstagramContainer({ ...args, cover: undefined }), coverRefused: true };
  }
}

/**
 * POST one container (`/{ig-id}/media` with `params`) and return its id. Shared by
 * the single-media container and the carousel's children and parent. Errors as
 * {@link createInstagramContainer} lists.
 */
async function postInstagramContainer(args: {
  igAccountId: string;
  params: Record<string, string>;
  connection: SocialConnection;
  deadline: number | undefined;
}): Promise<string> {
  const { igAccountId, params, connection, deadline } = args;

  const containerUrl = new URL(`${META_GRAPH_BASE_URL}/${igAccountId}/media`);
  Object.entries(params).forEach(([key, value]) => {
    containerUrl.searchParams.set(key, value);
  });

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
      // Roadmap Phase 4: flag before throwing (guarded, see throwInstagramReconnect).
      await throwInstagramReconnect(connection);
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    throw instagramCodedError(
      "INSTAGRAM_CONTAINER_FAILED",
      `Instagram container creation failed (status ${containerResponse.status})`,
    );
  }

  const containerData = (await containerResponse.json().catch(() => null)) as { id?: unknown } | null;
  const containerId = containerData?.id;
  // A 2xx without an id is not a container: saving it would send every later step to check
  // (or publish) `undefined`, or create another orphan each time. Nothing was published.
  if (typeof containerId !== "string" || containerId.length === 0) {
    console.error("[Instagram] Container creation answered without a container id", {
      status: containerResponse.status,
    });
    throw instagramCodedError(
      "INSTAGRAM_CONTAINER_FAILED",
      "Instagram container creation failed (no container id in the answer)",
    );
  }

  console.log("[Instagram] Container created", { containerId });
  return containerId;
}

/**
 * The last step of a publish: `media_publish` on a container that is ready. This is
 * the commit call, and it, with the reading of its answer, always finishes inside
 * one claimed step.
 */
async function publishInstagramContainer(args: {
  igAccountId: string;
  containerId: string;
  accessToken: string;
  connection: SocialConnection;
  deadline: number | undefined;
  username: string | undefined;
  /** The saved container state, when this publish keeps one (a REELS video polled across steps). */
  store: UploadStateStore | undefined;
}): Promise<PublishResult> {
  const { igAccountId, containerId, accessToken, connection, deadline, username, store } = args;

  const publishUrl = new URL(`${META_GRAPH_BASE_URL}/${igAccountId}/media_publish`);
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
  if (publishLimited) {
    // The cap refuses the publish outright (nothing was posted) and defers the result by
    // 24 h, by when this container would be discarded by Meta: drop it, so the deferred
    // attempt creates a new one instead of finding it EXPIRED. Any other throttle waits
    // far less than a container's life and keeps it.
    if (publishLimited.kind === "daily_limit" && store) await dropSavedContainer(store);
    throw publishLimited;
  }

  if (!publishResponse.ok) {
    const errorBody = await publishResponse.text().catch(() => "Unable to read error body");
    console.error("[Instagram] Publish failed", {
      status: publishResponse.status,
      error: errorBody,
    });
    // COR-5: token no longer valid (401, or OAuthException 190 on any
    // status) -> ask for reconnect.
    if (isGraphAuthFailure(publishResponse.status, errorBody)) {
      // Roadmap Phase 4: flag before throwing (guarded, see throwInstagramReconnect).
      await throwInstagramReconnect(connection);
    }
    // COR-3: never surface the raw upstream body via PostJobResult.errorMessage.
    throw instagramCodedError(
      "INSTAGRAM_PUBLISH_FAILED",
      `Instagram publish failed (status ${publishResponse.status})`,
    );
  }

  // media_publish answered 2xx, so the post may be live: an unreadable body is
  // PUBLISH_UNCONFIRMED, not a failure to retry (final review F4). So is a
  // body that parsed but has no post id (2026-11-02 scale audit).
  const publishData = await readCommitBody<{ id?: unknown } | null>(
    "instagram",
    publishResponse,
    "json",
  );

  const mediaId = requireCommitId("instagram", publishData?.id, "id");

  console.log("[Instagram] Media published successfully", {
    mediaId,
    username,
  });

  const permalink = await fetchInstagramPermalink(mediaId, accessToken, deadline);
  return permalink ? { externalPostId: mediaId, externalPostUrl: permalink } : { externalPostId: mediaId };
}

/** The permalink lookup is a nicety: it gets a few seconds, never the whole step. */
const INSTAGRAM_PERMALINK_TIMEOUT_MS = 5_000;

/**
 * The published post's public link (`GET /{media-id}?fields=permalink`), for
 * the Activity "View on Instagram" link: the media id itself is not a public
 * locator. Best effort, after the post is live: any failure (an error answer, a
 * timeout, a spent step budget, a link that isn't https://www.instagram.com/)
 * gives null, and the post is recorded as published without a link.
 */
async function fetchInstagramPermalink(
  mediaId: string,
  accessToken: string,
  deadline: number | undefined,
): Promise<string | null> {
  try {
    const url = new URL(`${META_GRAPH_BASE_URL}/${mediaId}`);
    url.searchParams.set("fields", "permalink");
    url.searchParams.set("access_token", accessToken);
    const response = await fetchWithTimeout(
      url.toString(),
      { method: "GET" },
      budgetedTimeout(INSTAGRAM_PERMALINK_TIMEOUT_MS, deadline),
    );
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { permalink?: unknown } | null;
    const permalink = data?.permalink;
    return typeof permalink === "string" && permalink.startsWith("https://www.instagram.com/") ? permalink : null;
  } catch {
    return null;
  }
}

// 07b: a post with several photos is one carousel
// (https://developers.facebook.com/docs/instagram-platform/content-publishing, "Carousel posts"):
// one container per photo with is_carousel_item=true, then one container with
// media_type=CAROUSEL, the children's ids in order and the caption, then media_publish on
// it. The parent is checked once in the step that creates it and, if not yet FINISHED,
// waits across steps with the same saved state a REELS video uses (see the header), so a
// step that ends before it is FINISHED never creates a second carousel. The
// children are not saved: if a step fails before the parent exists, the next try makes new
// ones, and Meta discards the unused ones after 24 h. Nothing is posted before media_publish.

/** The shared container messages speak of a video; a carousel's speak of the photos. */
const CAROUSEL_ERRORS: Record<string, { code: string; message: string }> = {
  INSTAGRAM_VIDEO_TIMEOUT: {
    code: "INSTAGRAM_CAROUSEL_TIMEOUT",
    message: "Instagram took too long to process the photos, so nothing was posted. Please retry.",
  },
  INSTAGRAM_VIDEO_PROCESSING_ERROR: {
    code: "INSTAGRAM_CAROUSEL_PROCESSING_ERROR",
    message: "Instagram could not process the photos, so nothing was posted.",
  },
  INSTAGRAM_CONTAINER_EXPIRED: {
    code: "INSTAGRAM_CONTAINER_EXPIRED",
    message: "Instagram discarded the photos before they were posted. Please retry.",
  },
};

function asCarouselError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const mapped = typeof code === "string" ? CAROUSEL_ERRORS[code] : undefined;
  return mapped ? Object.assign(instagramCodedError(mapped.code, mapped.message), { cause: error }) : error;
}

/**
 * One photo's child container. Photos may be sent again (nothing is posted), so a
 * refusal names the photo and fails the whole carousel: INSTAGRAM_CAROUSEL_ITEM_FAILED.
 * A throttle, a dead token and a spent step budget keep their own errors.
 */
async function createCarouselItem(args: {
  igAccountId: string;
  accessToken: string;
  connection: SocialConnection;
  photoUrl: string;
  position: number;
  count: number;
  deadline: number | undefined;
  /** 07d: this photo's description, if it has one. */
  altText?: string;
}): Promise<string> {
  const { igAccountId, accessToken, connection, photoUrl, position, count, deadline, altText } = args;
  console.log("[Instagram] Creating carousel item", { position, count });
  try {
    return await postInstagramContainer({
      igAccountId,
      params: {
        access_token: accessToken,
        is_carousel_item: "true",
        // The same fitted JPEG copy the single-photo path hands Instagram (instagramPhoto.ts).
        image_url: instagramImageUrl(photoUrl, process.env.NEXTAUTH_URL),
        ...(altText ? { alt_text: altText } : {}),
      },
      connection,
      deadline,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "INSTAGRAM_CONTAINER_FAILED") throw error;
    throw Object.assign(
      instagramCodedError(
        "INSTAGRAM_CAROUSEL_ITEM_FAILED",
        `Instagram did not accept photo ${position} of ${count}, so nothing was posted. Please retry.`,
      ),
      { cause: error },
    );
  }
}

async function publishInstagramCarousel(args: {
  ctx: PublishContext;
  igAccountId: string;
  accessToken: string;
  connection: SocialConnection;
  username: string | undefined;
}): Promise<PublishResult> {
  const { ctx, igAccountId, accessToken, connection, username } = args;
  const { mediaItems, caption, deadline } = ctx;
  const store = ctx.uploadState;

  // The create route allows only these; refuse anything else before a request is sent.
  const unsupported = mediaItems.findIndex((item) => !MULTI_PHOTO_MIME_TYPES.includes(item.mimeType ?? ""));
  if (unsupported >= 0) {
    throw instagramCodedError(
      "INSTAGRAM_CAROUSEL_UNSUPPORTED_MEDIA",
      `Instagram can only post several JPG, PNG or WebP photos together. Remove file ${unsupported + 1} and try again.`,
    );
  }

  console.log("[Instagram] Starting carousel", { count: mediaItems.length, igAccountId });

  try {
    let saved = store
      ? readContainerState((await store.load<unknown>(INSTAGRAM_CONTAINER_STATE_KIND))?.data)
      : null;
    if (store && saved && isStaleContainer(saved)) {
      console.log("[Instagram] Saved carousel is too old to publish; creating a new one", {
        containerId: saved.containerId,
        createdAt: saved.createdAt,
      });
      await dropSavedContainer(store);
      saved = null;
    }

    let containerId: string;
    if (store && saved) {
      const pending = await checkSavedContainer({ state: saved, accessToken, connection, store, deadline });
      if (pending) return pending;
      containerId = saved.containerId;
    } else {
      // One after another: each request has the single-photo path's own timeout,
      // clamped to the step budget.
      const children: string[] = [];
      for (const [index, item] of mediaItems.entries()) {
        children.push(
          await createCarouselItem({
            igAccountId,
            accessToken,
            connection,
            photoUrl: item.storageLocation,
            position: index + 1,
            count: mediaItems.length,
            deadline,
            altText: altTextOf(item, INSTAGRAM_ALT_TEXT_LIMIT),
          }),
        );
      }

      console.log("[Instagram] Creating carousel container", { count: children.length });
      containerId = await postInstagramContainer({
        igAccountId,
        params: {
          access_token: accessToken,
          media_type: "CAROUSEL",
          children: children.join(","),
          caption: computeInstagramCaption(caption),
        },
        connection,
        deadline,
      });

      if (store) {
        // Saved before the check below, so a step that dies between that check and
        // media_publish resumes this carousel and never creates a second one.
        const state: InstagramContainerState = { containerId, createdAt: new Date().toISOString(), checks: 0 };
        await store.save<InstagramContainerState>(INSTAGRAM_CONTAINER_STATE_KIND, { data: state });

        // Photos are usually ready at once: check now and publish in this step when
        // FINISHED, instead of always spending a minute and a step. The check counts
        // toward the five. Without room for a check and the publish, the next step checks.
        if (remainingMs(deadline) < INSTAGRAM_PUBLISH_RESERVE_MS + MIN_REQUEST_WINDOW_MS) {
          return continueInAMinute();
        }
        const pending = await checkSavedContainer({ state, accessToken, connection, store, deadline });
        if (pending) return pending;
      } else {
        await waitForInstagramContainer({ containerId, accessToken, connection, deadline });
      }
    }

    return await publishInstagramContainer({
      igAccountId,
      containerId,
      accessToken,
      connection,
      deadline,
      username,
      store,
    });
  } catch (error: unknown) {
    console.error("[Instagram] Carousel publish error", error);
    throw asCarouselError(error);
  }
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
      // Guarded like every other flag: the stored expiresAt this guard judged may
      // be stale (the user reconnected since this publish read the row).
      await flagExpiredToken(socialConnection, error);
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

    const story = ctx.instagramMetadata?.placement === "story";

    if (ctx.mediaItems.length > 1) {
      // The posts route refuses this; a Story is never quietly turned into a carousel.
      if (story) {
        throw instagramCodedError(
          "INSTAGRAM_STORY_ONE_FILE",
          "A Story takes one photo or video. Choose Feed for Instagram, or remove the extra photos.",
        );
      }
      return publishInstagramCarousel({
        ctx,
        igAccountId,
        accessToken,
        connection: socialConnection,
        username: metadata.username,
      });
    }

    console.log("[Instagram] Starting media upload", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
      igAccountId,
    });

    const mediaUrl = mediaItem.storageLocation;
    const isVideo = !!mediaItem.mimeType?.startsWith("video/");

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
      // A REELS video polls across steps when it is given somewhere to keep its
      // state (see the header). Images, and callers without a store, wait inside
      // the one step as before.
      const store = isVideo ? ctx.uploadState : undefined;
      let saved = store
        ? readContainerState((await store.load<unknown>(INSTAGRAM_CONTAINER_STATE_KIND))?.data)
        : null;
      if (store && saved && isStaleContainer(saved)) {
        // Meta discards a container after 24 h; a long deferral can outlast it. Replace it.
        console.log("[Instagram] Saved container is too old to publish; creating a new one", {
          containerId: saved.containerId,
          createdAt: saved.createdAt,
        });
        await dropSavedContainer(store);
        saved = null;
      }

      let containerId: string;
      let coverRefused = false;
      if (store && saved) {
        // A later step: the container exists. One status check; unless it is
        // FINISHED this step ends here with the claim released and nothing published.
        const pending = await checkSavedContainer({
          state: saved,
          accessToken,
          connection: socialConnection,
          store,
          deadline,
        });
        if (pending) return pending;
        containerId = saved.containerId;
        coverRefused = saved.coverRefused === true;
      } else {
        ({ containerId, coverRefused } = await createContainerWithCover({
          igAccountId,
          accessToken,
          connection: socialConnection,
          caption,
          mediaUrl,
          isVideo,
          locationId,
          deadline,
          story,
          altText: altTextOf(mediaItem, INSTAGRAM_ALT_TEXT_LIMIT),
          cover: ctx.cover,
        }));

        if (store) {
          // Step 1 of a REELS publish: keep the container for the next step. The
          // state is the only thing that crosses the step boundary, and it holds
          // no capability: the token is never stored.
          await store.save<InstagramContainerState>(INSTAGRAM_CONTAINER_STATE_KIND, {
            data: {
              containerId,
              createdAt: new Date().toISOString(),
              checks: 0,
              ...(coverRefused ? { coverRefused } : {}),
            },
          });
          return continueInAMinute();
        }

        if (isVideo) {
          console.log("[Instagram] Waiting for video processing...");

          // Bounded by the step deadline: stops with INSTAGRAM_VIDEO_TIMEOUT while
          // INSTAGRAM_PUBLISH_RESERVE_MS is still left for media_publish.
          await waitForInstagramContainer({
            containerId,
            accessToken,
            connection: socialConnection,
            deadline,
          });

          console.log("[Instagram] Video processing complete");
        } else {
          // For images, wait a brief moment for Instagram to process
          console.log("[Instagram] Waiting for image processing...");
          await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
        }
      }

      const published = await publishInstagramContainer({
        igAccountId,
        containerId,
        accessToken,
        connection: socialConnection,
        deadline,
        username: metadata.username,
        store,
      });
      return coverRefused ? { ...published, note: INSTAGRAM_COVER_REFUSED_NOTE } : published;
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
      // Roadmap Phase 4: flag before throwing. A refresher (the health sweep calls
      // this through refreshConnectionToken), so the flag is guarded by the stored
      // tokens and throws TOKEN_REFRESH_SUPERSEDED, which the helper turns into the
      // stored row, when they changed (2026-11-01 scale audit, jobs, token refresh).
      await flagTerminalRefreshFailure(connection, INSTAGRAM_RECONNECT_CODE);
      throw error;
    }
  },
};
