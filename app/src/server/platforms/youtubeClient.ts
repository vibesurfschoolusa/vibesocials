import type { SocialConnection } from "@prisma/client";

import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PUBLISH_UNCONFIRMED_CODE } from "@/lib/publishOutcomes";
import { fitTitle } from "@/lib/truncate";
import {
  YOUTUBE_UPLOAD_STATE_KIND,
  type UploadSnapshot,
  type UploadStateStore,
} from "@/server/jobs/uploadState";

import {
  commitRequest,
  publishUnconfirmedError,
  readCommitBody,
  requireCommitId,
} from "./commitCall";
import { refreshConnectionToken } from "./connectionRefresh";
import { refreshGoogleToken } from "./googleTokens";
import {
  blobInterruptionDetails,
  isBlobStreamInterrupted,
  isTransientUploadFailure,
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
  openBlobChunkStream,
  usesLargeUploadPath,
  type BlobChunkStream,
} from "./largeUpload";
import { budgetedTimeout, PUBLISH_BUDGET_EXCEEDED_CODE, remainingMs } from "./publishBudget";
import { classifyRateLimit, isRateLimitedError } from "./rateLimited";
import { isNeverConnectedFetchError } from "./transientRetry";
import type { PlatformClient, PublishContext, PublishResult } from "./types";

// Minimal shape of the YouTube `videos.insert` request body we construct.
// recordingDetails is added conditionally when location data is present.
interface YouTubeVideoResource {
  snippet: {
    title: string;
    description: string;
    categoryId: string;
    tags?: string[];
  };
  status: {
    privacyStatus: string;
    selfDeclaredMadeForKids: boolean;
  };
  recordingDetails?: {
    location: { latitude: number; longitude: number };
    locationDescription?: string;
  };
}

/** YouTube's hard limit on a video title. */
const YOUTUBE_TITLE_MAX_GRAPHEMES = 100;

/**
 * Per-request timeouts, each further clamped to the time left in the step by
 * budgetedTimeout (2026-11-01 scale audit, step budget, Task 7).
 */
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 120_000;
const YOUTUBE_UPLOAD_TIMEOUT_MS = 120_000;

// 2026-11-02 scale audit (jobs B3): a video above LARGE_VIDEO_THRESHOLD_BYTES
// (largeUpload.ts) on a platform listed in LARGE_UPLOAD_PLATFORMS uploads through
// YouTube's resumable protocol instead of one multipart request that holds the
// whole file twice. Source of every protocol fact below:
// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
//
//   start    POST ...?uploadType=resumable with the video resource as the body and
//            X-Upload-Content-Length / X-Upload-Content-Type. The answer is 2xx with
//            the session URI in `Location`.
//   chunks   PUT <session URI> with `Content-Range: bytes FIRST-LAST/TOTAL`. "The
//            chunk size must be a multiple of 256 KB", except the last chunk. A chunk
//            that is not the last answers 308 (with `Range: 0-N`, absent when nothing
//            was received); the last answers 201 with the created video.
//   status   an empty PUT with `Content-Range: bytes */TOTAL` answers 308 (incomplete,
//            see Range), 200/201 (complete: the same answer as at completion) or 404
//            (the session expired: start over).
//
// The session URI is a capability URL (whoever holds it can write the upload), so it
// is saved only sealed (uploadState.ts) and never logged. The upload spans steps:
// each step asks the session where it stands, then sends chunks while the step
// budget allows, then saves and returns a continuation (platformSteps.ts).

/**
 * Size of each chunk: 16 MiB = 64 x 256 KiB, so every chunk but the last is a
 * multiple of 256 KiB. One buffer of this size is all the memory a step holds for
 * the media, and a chunk takes about 64 s at 0.25 MB/s.
 */
export const YOUTUBE_RESUMABLE_CHUNK_BYTES = 16_777_216;

/** Timeout of the status query. It reads nothing and writes nothing, so it is short. */
export const YOUTUBE_STATUS_TIMEOUT_MS = 15_000;

/** Timeout of the request that starts a session (a small JSON request). */
const YOUTUBE_SESSION_START_TIMEOUT_MS = 30_000;

/**
 * The last chunk is the commit call, so it starts only with this much of the step
 * left: time for the chunk itself (its timeout is cut by {@link YOUTUBE_STATUS_TIMEOUT_MS}
 * so the answer to an ambiguous outcome can still be asked for) and then that status
 * query. 90 s = 75 s for the chunk + 15 s for the query.
 */
export const YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS = 90_000;

/**
 * Chunk failures one step recovers from (a 5xx, a timeout or a dropped connection,
 * and a 308 that confirmed nothing new). The next one saves the progress and
 * continues in a new step instead of asking again.
 */
export const YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP = 2;

/**
 * When the step has to stop because a request got no usable answer (see isTransientUploadFailure
 * in largeUpload.ts) or the chunk recoveries are spent, it saves its place and the next one starts
 * this long after: a short pause, so an outage does not burn the continuations (platformSteps.ts)
 * in a few seconds. A step that is simply out of time continues at once.
 */
export const YOUTUBE_TRANSIENT_RESUME_DELAY_MS = 30_000;

/**
 * New sessions one result may start after the first because the session was gone (a 404 from
 * the status query). Each new session spends a slot of the app-wide daily upload counter
 * (youtubeQuota.ts), so a session that keeps disappearing must not burn one slot per
 * continuation: the next 404 is YOUTUBE_UPLOAD_FAILED. The same cap as LinkedIn's
 * LINKEDIN_MAX_UPLOAD_RESTARTS.
 */
export const YOUTUBE_MAX_SESSION_RESTARTS = 2;

const YOUTUBE_RESUMABLE_START_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Bytes of the video read from `start`, held while they are sent (and resent after a partial 308). */
interface HeldChunk {
  start: number;
  bytes: Buffer;
}

/** What a step saves as readable progress. No URL may be in it (uploadState.ts). */
interface YouTubeResumableData {
  totalBytes: number;
  confirmedBytes: number;
  /** New sessions started after the first (see {@link YOUTUBE_MAX_SESSION_RESTARTS}); absent means 0. */
  sessionRestarts?: number;
}

/**
 * What a step saves when the session is gone: only the restart count, with no secret and no URL.
 * The next step finds no sealed session, so publishToPlatform spends a slot for it and the client
 * starts the new session, carrying the count.
 */
interface YouTubeRestartTombstone {
  sessionRestarts: number;
}

/** Either saved shape, as `load` hands it back: nothing in it is trusted until checked. */
type SavedYouTubeData = Partial<Record<keyof YouTubeResumableData, unknown>>;

/** The restart count a saved state carries: a whole number of at least 0, else 0. */
function sessionRestartsOf(data: SavedYouTubeData | null | undefined): number {
  const value = data?.sessionRestarts;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The readable progress of a session: the restart count only when there has been one. */
function progressData(totalBytes: number, confirmedBytes: number, sessionRestarts: number): YouTubeResumableData {
  return sessionRestarts > 0 ? { totalBytes, confirmedBytes, sessionRestarts } : { totalBytes, confirmedBytes };
}

/** What a step saves sealed: the session URI is a capability URL. */
interface YouTubeResumableSecret {
  sessionUri: string;
}

// Answer to "where does the session stand?" (the status query, see the header above).
type UploadStatus =
  | { kind: "incomplete"; confirmedBytes: number }
  /** 200/201: the upload is complete; `response` holds the created video. */
  | { kind: "complete"; response: Response }
  /** 404: the session is gone; a new one has to be started. */
  | { kind: "expired" };

/**
 * Fit text into YouTube's title limit without cutting it mid-sentence
 * (2026-11-08): see {@link fitTitle} (lib/truncate.ts) for the rules.
 */
export function fitYouTubeTitle(text: string, max: number = YOUTUBE_TITLE_MAX_GRAPHEMES): string {
  return fitTitle(text, max);
}

/**
 * The video title: the POST's own base caption (no footer) — the job's
 * snapshot via `ctx.baseCaption`, the shared MediaItem's only for legacy jobs
 * — else the full caption, fitted to YouTube's 100-grapheme limit by
 * {@link fitYouTubeTitle}. The description carries the full caption (with
 * footer).
 */
export function computeYouTubeTitle(
  ctx: Pick<PublishContext, "baseCaption" | "caption"> & {
    mediaItem: Pick<PublishContext["mediaItem"], "baseCaption">;
  },
): string {
  const baseCaption = ctx.baseCaption ?? ctx.mediaItem.baseCaption;
  return fitYouTubeTitle(baseCaption || ctx.caption);
}

/**
 * The `videos.insert` request body for this post, and the `part` parameter that
 * names the resources it writes. The multipart upload and the resumable session
 * start send the same resource.
 *
 * Hashtags in the caption become tags; a location with coordinates becomes
 * `recordingDetails`. The title is the post's own base caption (see
 * {@link computeYouTubeTitle}), the description the full caption.
 */
export function buildYouTubeVideoResource(ctx: PublishContext): {
  metadata: YouTubeVideoResource;
  apiParts: string;
  locationData: { latitude?: number; longitude?: number; description?: string } | null;
} {
  const { mediaItem, caption } = ctx;

  // Extract hashtags from caption for tags (YouTube supports up to 500 chars of tags)
  const hashtagMatches = caption.match(/#[\w]+/g) || [];
  const tags = hashtagMatches.map(tag => tag.substring(1)); // Remove # prefix

  // Parse location from metadata if available
  // Supports formats: "lat,lng" or "description" or both
  const locationMetadata = (mediaItem.metadata as { location?: { description?: string } } | null)?.location;
  let locationData: { latitude?: number; longitude?: number; description?: string } | null = null;

  console.log("[YouTube] Raw metadata from mediaItem:", {
    metadata: mediaItem.metadata,
    locationMetadata,
  });

  if (locationMetadata?.description) {
    const locStr = locationMetadata.description.trim();

    console.log("[YouTube] Parsing location string:", locStr);

    // Try to extract coordinates from the string (format: "lat,lng" or "description (lat,lng)")
    const coordMatch = locStr.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);

    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);

      console.log("[YouTube] Found coordinates:", { lat, lng, valid: !isNaN(lat) && !isNaN(lng) });

      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        locationData = {
          latitude: lat,
          longitude: lng,
        };

        // Extract description if it's not just coordinates
        const descOnly = locStr.replace(/\s*\(?\s*-?\d+\.?\d*,\s*-?\d+\.?\d*\s*\)?/, '').trim();
        if (descOnly && descOnly !== locStr) {
          locationData.description = descOnly;
        }

        console.log("[YouTube] Parsed location data:", locationData);
      }
    } else {
      // No coordinates found, store as description only for other platforms
      // YouTube won't get location without coordinates
      console.log("[YouTube] Location text provided but no coordinates, skipping location for YouTube:", locStr);
    }
  } else {
    console.log("[YouTube] No location metadata found");
  }

  // YouTube video metadata: the post's base caption for the title (no
  // footer), the full caption for the description (with footer).
  const title = computeYouTubeTitle(ctx);
  const metadata: YouTubeVideoResource = {
    snippet: {
      title,
      description: caption, // Full caption with footer
      categoryId: "22", // People & Blogs (default category)
      tags: tags.length > 0 ? tags : undefined, // Add extracted hashtags as tags
    },
    status: {
      privacyStatus: ctx.youtubeMetadata?.privacyStatus ?? "unlisted", // User-selected; defaults to unlisted, never auto-public
      selfDeclaredMadeForKids: false, // Not made for kids
    },
  };

  // Add location/recording details if available
  if (locationData?.latitude && locationData?.longitude) {
    metadata.recordingDetails = {
      location: {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
      },
    };
    if (locationData.description) {
      metadata.recordingDetails.locationDescription = locationData.description;
    }
  }

  console.log("[YouTube] Uploading with metadata", {
    title: metadata.snippet.title,
    descriptionLength: caption.length,
    tags: tags,
    location: locationData ? {
      lat: locationData.latitude,
      lng: locationData.longitude,
      description: locationData.description,
    } : null,
    privacyStatus: metadata.status.privacyStatus,
    madeForKids: false,
  });

  // Upload to YouTube
  // Include recordingDetails in parts if location is provided
  const apiParts = locationData ? "snippet,status,recordingDetails" : "snippet,status";
  return { metadata, apiParts, locationData };
}

/**
 * The commit call answered 2xx ("created" or, for a resumable session, "complete"):
 * read the video id from its body.
 *
 * The video may exist, so an unreadable body is PUBLISH_UNCONFIRMED, not a failure
 * to retry (final review F4). So is a body that parsed but has no video id
 * (2026-11-02 scale audit): the former plain YOUTUBE_NO_VIDEO_ID failure invited a
 * retry, which uploads it twice.
 */
async function completedUpload(response: Response): Promise<PublishResult> {
  const result = await readCommitBody<{
    id?: unknown;
    snippet?: {
      title?: string;
    };
  } | null>("youtube", response, "json");

  const videoId = requireCommitId("youtube", result?.id, "id");

  console.log("[YouTube] Video uploaded successfully", {
    videoId,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: result?.snippet?.title,
  });

  return { externalPostId: videoId };
}

function youtubeUploadError(message: string, status?: number): Error & { code: string; status?: number } {
  const error = new Error(message) as Error & { code: string; status?: number };
  error.code = "YOUTUBE_UPLOAD_FAILED";
  if (status !== undefined) error.status = status;
  return error;
}

/**
 * Throws for a response that is neither progress nor success: a quota or rate
 * limit becomes RATE_LIMITED (as for the multipart insert, 2026-11-01 scale audit,
 * platform limits), anything else YOUTUBE_UPLOAD_FAILED with its status.
 */
async function rejectedByYouTube(response: Response, prefix: string): Promise<never> {
  const limited = await classifyRateLimit("youtube", response);
  if (limited) throw limited;
  await assertOk(response, { code: "YOUTUBE_UPLOAD_FAILED", prefix });
  // assertOk throws for every response that is not ok; this is for the types.
  throw youtubeUploadError(`${prefix} (status ${response.status})`, response.status);
}

/** Did this request fail before anything could have reached YouTube? The same test commitCall.ts applies. */
function wasNeverSent(error: unknown): boolean {
  if (error instanceof TypeError && isNeverConnectedFetchError(error)) return true;
  return (error as { code?: unknown } | null)?.code === PUBLISH_BUDGET_EXCEEDED_CODE;
}

/** The session URI is sent the bearer token, so it must be an https URL. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Ask the run to call this platform again straight away. */
function continueNow(): PublishResult {
  return continueAfter(null);
}

/** Ask the run to call this platform again, no sooner than `delayMs` from now (null: straight away). */
function continueAfter(delayMs: number | null): PublishResult {
  return { continuation: { resumeAt: delayMs === null ? null : Date.now() + delayMs } };
}

/**
 * Bytes the session holds, from the `Range` of a 308: `bytes=0-N` (the docs also
 * write it `0-N`) means N + 1 bytes, no header means none. Anything else cannot be
 * resumed from (YOUTUBE_UPLOAD_FAILED: nothing is committed while a session is
 * incomplete). A range that covers the whole video on an answer that says
 * "incomplete" contradicts itself: the video may be about to appear, so that is
 * PUBLISH_UNCONFIRMED and is never retried blindly.
 */
function confirmedFromRange(response: Response, totalBytes: number): number {
  const header = response.headers.get("Range");
  if (header === null) return 0;
  const match = /^(?:bytes=)?0-(\d+)$/i.exec(header.trim());
  const confirmed = match ? Number(match[1]) + 1 : Number.NaN;
  if (!Number.isSafeInteger(confirmed)) {
    throw youtubeUploadError("YouTube answered with an upload position that could not be read.");
  }
  if (confirmed >= totalBytes) {
    throw publishUnconfirmedError("youtube", new Error("308 whose range covers the whole video"));
  }
  return confirmed;
}

interface SessionRequest {
  sessionUri: string;
  accessToken: string;
  totalBytes: number;
  deadline: number | undefined;
}

/**
 * Start a resumable session. This is not the commit call (no video exists until
 * the last chunk lands), so a 5xx or a network error is an ordinary failure that
 * the in-step retry may repeat. Returns the session URI from `Location`.
 *
 * A quota or rate-limit answer is classified first, as for the multipart insert.
 */
async function startUploadSession(args: {
  ctx: PublishContext;
  accessToken: string;
  totalBytes: number;
}): Promise<string> {
  const { ctx, accessToken, totalBytes } = args;
  const { metadata, apiParts } = buildYouTubeVideoResource(ctx);

  const response = await fetchWithTimeout(
    `${YOUTUBE_RESUMABLE_START_URL}?uploadType=resumable&part=${apiParts}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(totalBytes),
        "X-Upload-Content-Type": ctx.mediaItem.mimeType || "video/mp4",
      },
      body: JSON.stringify(metadata),
    },
    budgetedTimeout(YOUTUBE_SESSION_START_TIMEOUT_MS, ctx.deadline),
  );

  const limited = await classifyRateLimit("youtube", response);
  if (limited) throw limited;
  await assertOk(response, { code: "YOUTUBE_UPLOAD_FAILED", prefix: "YouTube upload failed" });
  void response.body?.cancel().catch(() => {});

  const location = response.headers.get("Location");
  if (!location || !isHttpsUrl(location)) {
    throw youtubeUploadError("YouTube did not return a usable upload location.", response.status);
  }
  return location;
}

/**
 * Where does the session stand? An empty PUT whose Content-Range is `bytes *` over
 * the total (see the header above): 308 is incomplete (see Range), 200/201 is
 * complete, 404 means the session is gone. It writes nothing, so a failure is an
 * ordinary one (RATE_LIMITED for a quota or rate-limit answer, YOUTUBE_UPLOAD_FAILED
 * for the rest); the caller decides what it means for the upload.
 */
async function queryUploadStatus(args: SessionRequest): Promise<UploadStatus> {
  const response = await fetchWithTimeout(
    args.sessionUri,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Length": "0",
        "Content-Range": `bytes */${args.totalBytes}`,
      },
    },
    budgetedTimeout(YOUTUBE_STATUS_TIMEOUT_MS, args.deadline),
  );

  if (response.status === 308) {
    return { kind: "incomplete", confirmedBytes: confirmedFromRange(response, args.totalBytes) };
  }
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    return { kind: "expired" };
  }
  if (response.ok) return { kind: "complete", response };
  return rejectedByYouTube(response, "YouTube upload status check failed");
}

/**
 * Act on a status answer: finish (complete), or replace an expired session with a
 * tombstone so the next step starts a new one, or hand back the position to resume from.
 *
 * An expired session is not restarted in this step: the new session spends a slot of the
 * daily upload counter (youtubeQuota.ts), and only publishToPlatform spends slots - it does
 * so for a step that finds no sealed session. The tombstone (the restart count, no secret,
 * no URL) is that step's signal, and it carries the count: after
 * {@link YOUTUBE_MAX_SESSION_RESTARTS} restarts the next expiry fails the upload. Nothing
 * was posted: a session that is gone never completed.
 */
async function settleStatus(
  answer: UploadStatus,
  store: UploadStateStore,
  totalBytes: number,
  sessionRestarts: number,
): Promise<{ done: PublishResult } | { confirmedBytes: number }> {
  if (answer.kind === "complete") return { done: await completedUpload(answer.response) };
  if (answer.kind === "expired") {
    if (sessionRestarts >= YOUTUBE_MAX_SESSION_RESTARTS) {
      console.error("[YouTube] The upload session was lost again after the last allowed restart", {
        totalBytes,
        sessionRestarts,
      });
      throw youtubeUploadError(
        "YouTube kept losing the upload session before the video was uploaded. Nothing was posted — please retry.",
      );
    }
    await store.save<YouTubeRestartTombstone>(YOUTUBE_UPLOAD_STATE_KIND, {
      data: { sessionRestarts: sessionRestarts + 1 },
    });
    console.warn("[YouTube] The upload session expired; a new one starts in the next step", {
      totalBytes,
      sessionRestarts: sessionRestarts + 1,
    });
    return { done: continueNow() };
  }
  return { confirmedBytes: answer.confirmedBytes };
}

/**
 * The status answer after the LAST chunk failed in a way that says nothing about
 * whether it was committed (a 5xx, a timeout, a dropped connection). Complete or
 * incomplete is answered by YouTube; everything else - an expired session, a
 * failing query, no time to ask - leaves the outcome unknown, so the original
 * PUBLISH_UNCONFIRMED stands and nothing is retried.
 */
async function statusAfterAmbiguousFinalChunk(
  args: SessionRequest,
  unconfirmed: Error,
): Promise<Exclude<UploadStatus, { kind: "expired" }>> {
  let answer: UploadStatus;
  try {
    answer = await queryUploadStatus(args);
  } catch (error) {
    console.warn("[YouTube] The status check after the last chunk failed; reporting it unconfirmed", {
      code: (error as { code?: unknown } | null)?.code,
      status: (error as { status?: unknown } | null)?.status,
    });
    throw unconfirmed;
  }
  if (answer.kind === "expired") {
    console.warn("[YouTube] The session is gone after the last chunk was sent; reporting it unconfirmed");
    throw unconfirmed;
  }
  return answer;
}

/**
 * Send chunks from `startAt` while the step budget allows. Returns the created
 * video, or a continuation once the budget is spent (the progress is saved first).
 *
 * - One GET of the blob serves the whole step; one 16 MiB buffer is held at a time.
 * - A chunk that is not the last starts only with LARGE_UPLOAD_CHUNK_WINDOW_MS left; the
 *   last (the commit call) only with {@link YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS} left.
 * - A 308 that confirms less than was sent resends the rest from the same buffer.
 * - A chunk that fails without an answer is checked with a status query, then resumed
 *   from what the session holds. For the last chunk that query decides the outcome. For
 *   any other chunk a step that is out of time (under LARGE_UPLOAD_CHUNK_WINDOW_MS left)
 *   saves and continues at once; one whose query gets no answer, or whose recoveries are
 *   spent, saves and continues {@link YOUTUBE_TRANSIENT_RESUME_DELAY_MS} later. A TypeError
 *   that is not undici's network failure is a bug and surfaces.
 * - A quota or rate limit saves the progress, then throws RATE_LIMITED: the deferred
 *   step resumes from the session, which costs no new slot.
 */
async function uploadChunks(args: {
  ctx: PublishContext;
  accessToken: string;
  store: UploadStateStore;
  sessionUri: string;
  totalBytes: number;
  confirmedBytes: number;
  sessionRestarts: number;
}): Promise<PublishResult> {
  const { ctx, accessToken, store, sessionUri, totalBytes, sessionRestarts } = args;
  const { mediaItem, deadline } = ctx;
  const session: SessionRequest = { sessionUri, accessToken, totalBytes, deadline };

  let confirmedBytes = args.confirmedBytes;
  let chunk: HeldChunk | null = null;
  let problems = 0;
  // Held in an object so the finally block sees the stream a closure opened.
  const source: { stream: BlobChunkStream | null } = { stream: null };

  const saveProgress = () =>
    store.save<YouTubeResumableData, YouTubeResumableSecret>(YOUTUBE_UPLOAD_STATE_KIND, {
      data: progressData(totalBytes, confirmedBytes, sessionRestarts),
      secret: { sessionUri },
    });

  /** Save and hand the claim back: the run calls this client again, no sooner than `delayMs` from now. */
  const pause = async (delayMs: number | null): Promise<PublishResult> => {
    await saveProgress();
    console.log("[YouTube] Resumable upload continues in another step", { confirmedBytes, totalBytes });
    return continueAfter(delayMs);
  };

  /** The next `length` bytes of the video, read from `confirmedBytes` (one open stream, read in order). */
  const readChunk = async (length: number): Promise<HeldChunk> => {
    if (source.stream !== null && source.stream.position !== confirmedBytes) {
      await source.stream.close();
      source.stream = null;
    }
    source.stream ??= await openBlobChunkStream(mediaItem.storageLocation, {
      offset: confirmedBytes,
      totalBytes,
      deadline,
    });
    return { start: confirmedBytes, bytes: await source.stream.read(length) };
  };

  try {
    while (confirmedBytes < totalBytes) {
      // The bytes to send: what is left of the buffer after a partial 308, else the next chunk.
      const held: HeldChunk | null =
        chunk !== null && confirmedBytes >= chunk.start && confirmedBytes < chunk.start + chunk.bytes.length
          ? chunk
          : null;
      const endsAt = held
        ? held.start + held.bytes.length
        : Math.min(confirmedBytes + YOUTUBE_RESUMABLE_CHUNK_BYTES, totalBytes);
      const isFinal = endsAt >= totalBytes;

      const needed = isFinal ? YOUTUBE_FINAL_CHUNK_MIN_WINDOW_MS : LARGE_UPLOAD_CHUNK_WINDOW_MS;
      if (remainingMs(deadline) < needed) return await pause(null);

      if (held === null) chunk = null; // let the finished buffer go before reading the next
      let current: HeldChunk;
      if (held !== null) {
        current = held;
      } else {
        try {
          current = await readChunk(endsAt - confirmedBytes);
        } catch (error) {
          // Reading runs into the deadline, or the blob's body drops part-way through: nothing of
          // the chunk was sent, so this is not a failure of the upload. The next step asks the
          // session and reads from there (a little later after a drop). A blob that refuses the
          // read still fails.
          if (remainingMs(deadline) < needed) return await pause(null);
          if (isBlobStreamInterrupted(error)) {
            console.warn("[YouTube] Reading the stored video stopped part-way through; pausing", blobInterruptionDetails(error));
            return await pause(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
          }
          throw error;
        }
        // Reading takes time too: the chunk (and, for the last, the status query after it) must still fit.
        if (remainingMs(deadline) < needed) return await pause(null);
      }
      chunk = current;
      // Read into Buffer.allocUnsafe (largeUpload.ts), so it is ArrayBuffer-backed: the
      // cast only narrows the type `subarray` widens.
      const body = current.bytes.subarray(confirmedBytes - current.start) as Buffer<ArrayBuffer>;
      const lastByte = current.start + current.bytes.length - 1;

      const send = () =>
        fetchWithTimeout(
          sessionUri,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Length": String(body.length),
              "Content-Range": `bytes ${confirmedBytes}-${lastByte}/${totalBytes}`,
            },
            body,
          },
          // The last chunk leaves room for the status query that settles an unclear answer.
          budgetedTimeout(
            LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
            isFinal && deadline !== undefined ? deadline - YOUTUBE_STATUS_TIMEOUT_MS : deadline,
          ),
        );

      let response: Response;
      try {
        if (isFinal) {
          // The commit call: a 5xx, a timeout or a dropped connection is PUBLISH_UNCONFIRMED
          // (commitCall.ts) until the status query below says otherwise.
          response = await commitRequest("youtube", send);
        } else {
          response = await send();
          if (response.status >= 500) {
            void response.body?.cancel().catch(() => {});
            throw Object.assign(new Error(`Chunk answered HTTP ${response.status}`), { status: response.status });
          }
        }
      } catch (error) {
        // A chunk that is not the last commits nothing, so running into the deadline is not a
        // failure of the upload: with no time left to send another chunk (or to ask the session),
        // the step saves and continues, and the next one begins with the status query anyway.
        // That covers a chunk that was aborted at the deadline and a request that was never
        // sent because the budget ran out (PUBLISH_TIME_BUDGET_EXCEEDED leaves under 5 s).
        // Failing here would record the result failed and drop the state with everything
        // uploaded so far. A bug (a TypeError that is not undici's network failure) is not a
        // chunk without an answer: it surfaces below even this close to the deadline.
        if (!isFinal && remainingMs(deadline) < LARGE_UPLOAD_CHUNK_WINDOW_MS && isTransientUploadFailure(error)) {
          return await pause(null);
        }
        if (wasNeverSent(error)) throw error;

        let answer: UploadStatus;
        if (isFinal) {
          if ((error as { code?: unknown } | null)?.code !== PUBLISH_UNCONFIRMED_CODE) throw error;
          answer = await statusAfterAmbiguousFinalChunk(session, error as Error);
        } else {
          // A TypeError that is not undici's network failure (or any other error we do not
          // recognise) is a bug, not a chunk without an answer: it surfaces.
          if (!isTransientUploadFailure(error)) throw error;
          problems += 1;
          if (problems > YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP) return await pause(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
          console.warn("[YouTube] A chunk got no usable answer; asking the session where it stands", {
            confirmedBytes,
            totalBytes,
            status: (error as { status?: unknown } | null)?.status,
            code: (error as { code?: unknown } | null)?.code,
          });
          try {
            answer = await queryUploadStatus(session);
          } catch (statusError) {
            // Nothing was committed and the query only reads: if it gets no answer (a 5xx, a
            // timeout, a dropped connection), the next step asks again with a whole budget
            // instead of this one failing on a transient error it has no time to retry.
            if (!isTransientUploadFailure(statusError)) throw statusError;
            console.warn("[YouTube] The status query got no answer; the next step asks again", {
              confirmedBytes,
              totalBytes,
              status: (statusError as { status?: unknown } | null)?.status,
              code: (statusError as { code?: unknown } | null)?.code,
            });
            return await pause(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
          }
        }

        const settled = await settleStatus(answer, store, totalBytes, sessionRestarts);
        if ("done" in settled) return settled.done;
        confirmedBytes = settled.confirmedBytes;
        // The last chunk's outcome is known (incomplete), but resending it is bounded like any recovery.
        if (isFinal && ++problems > YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP) {
          return await pause(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
        }
        continue;
      }

      if (response.status === 308) {
        const advanced = confirmedFromRange(response, totalBytes);
        const progressed = advanced > confirmedBytes;
        confirmedBytes = advanced;
        console.log("[YouTube] Resumable chunk accepted", { confirmedBytes, totalBytes });
        // A 308 that confirms nothing new would be resent forever; it counts like a failure.
        if (!progressed && ++problems > YOUTUBE_MAX_CHUNK_RECOVERIES_PER_STEP) {
          return await pause(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
        }
        continue;
      }

      // 2xx: the upload is complete (the video exists, whichever chunk this was).
      if (response.ok) return await completedUpload(response);

      // The chunk was rejected, not committed: a quota or rate limit waits, the rest fails.
      return await rejectedByYouTube(response, "YouTube upload failed");
    }

    // Every byte is confirmed yet no answer said "complete": the video may be about to appear.
    throw publishUnconfirmedError("youtube", new Error("all bytes confirmed without a completed upload"));
  } catch (error) {
    if (isRateLimitedError(error)) {
      // The deferral resumes from here. Best effort: the session itself is the truth and
      // the next step asks it, so a failed save must not hide the rate limit.
      await saveProgress().catch((saveError: unknown) => {
        console.warn("[YouTube] Could not save the upload progress before the rate-limit wait", {
          code: (saveError as { code?: unknown } | null)?.code,
        });
      });
    }
    throw error;
  } finally {
    await source.stream?.close();
  }
}

/**
 * The resumable path (2026-11-02 scale audit, jobs B3). Whether to start a session
 * or resume one is decided by `saved` alone - never by `ctx.continuation`: if a
 * step's output is lost after it continued, the same step number runs again with the
 * state already there and must resume, not start a second session.
 *
 * - No sealed session (no state, or the tombstone of an expired one): start a session and
 *   save it AT ONCE, before the first chunk, carrying the tombstone's restart count. The
 *   session costs one slot of the daily upload counter, spent by publishToPlatform when it
 *   finds no sealed session; a rate limit on a chunk then resumes the saved session instead
 *   of costing a second slot.
 * - State: ask the session where it stands, then send chunks from there. A query that gets
 *   no answer continues {@link YOUTUBE_TRANSIENT_RESUME_DELAY_MS} later with the state as it is.
 * - A sealed session that cannot be used (another size, a URI that is not https) is
 *   dropped, and the next step starts over.
 */
async function publishResumable(args: {
  ctx: PublishContext;
  accessToken: string;
  store: UploadStateStore;
  saved: UploadSnapshot<SavedYouTubeData, YouTubeResumableSecret> | null;
}): Promise<PublishResult> {
  const { ctx, accessToken, store, saved } = args;
  const totalBytes = ctx.mediaItem.sizeBytes;
  const sessionRestarts = sessionRestartsOf(saved?.data);

  // The same test publishToPlatform makes before it spends a slot: no sealed session saved.
  if (saved === null || saved.secret === undefined) {
    const sessionUri = await startUploadSession({ ctx, accessToken, totalBytes });
    await store.save<YouTubeResumableData, YouTubeResumableSecret>(YOUTUBE_UPLOAD_STATE_KIND, {
      data: progressData(totalBytes, 0, sessionRestarts),
      secret: { sessionUri },
    });
    console.log("[YouTube] Resumable upload session started", { totalBytes, sessionRestarts });
    return uploadChunks({ ctx, accessToken, store, sessionUri, totalBytes, confirmedBytes: 0, sessionRestarts });
  }

  const sessionUri = saved.secret?.sessionUri;
  if (
    typeof sessionUri !== "string" ||
    !isHttpsUrl(sessionUri) ||
    saved.data?.totalBytes !== totalBytes
  ) {
    await store.clear();
    console.warn("[YouTube] The saved upload session cannot be used; a new one starts in the next step", {
      totalBytes,
    });
    return continueNow();
  }

  let answer: UploadStatus;
  try {
    answer = await queryUploadStatus({ sessionUri, accessToken, totalBytes, deadline: ctx.deadline });
  } catch (error) {
    // The query only reads, and the session holds what was uploaded: with no answer (a 5xx, a
    // timeout, a dropped connection) the next step asks again, the saved state untouched. Failing
    // here would drop the state, and the retry would spend a new slot on a new session.
    if (!isTransientUploadFailure(error)) throw error;
    console.warn("[YouTube] The status query got no answer; the next step asks again", {
      totalBytes,
      status: (error as { status?: unknown } | null)?.status,
      code: (error as { code?: unknown } | null)?.code,
    });
    return continueAfter(YOUTUBE_TRANSIENT_RESUME_DELAY_MS);
  }
  const settled = await settleStatus(answer, store, totalBytes, sessionRestarts);
  if ("done" in settled) return settled.done;

  console.log("[YouTube] Resuming the upload", { confirmedBytes: settled.confirmedBytes, totalBytes });
  return uploadChunks({
    ctx,
    accessToken,
    store,
    sessionUri,
    totalBytes,
    confirmedBytes: settled.confirmedBytes,
    sessionRestarts,
  });
}

export const youtubeClient: PlatformClient = {
  async publishVideo(ctx: PublishContext): Promise<PublishResult> {
    let { socialConnection } = ctx;
    const { mediaItem, deadline } = ctx;

    // 2026-11-02 scale audit (jobs B3): a video above 50 MiB on a platform enabled in
    // LARGE_UPLOAD_PLATFORMS - or any upload that already has saved state - takes the
    // resumable path; everything else keeps the multipart upload below, unchanged.
    // The saved state alone decides, so it is read before anything else.
    const store = ctx.uploadState;
    const saved = store
      ? await store.load<SavedYouTubeData, YouTubeResumableSecret>(YOUTUBE_UPLOAD_STATE_KIND)
      : null;
    const resumable =
      store !== undefined &&
      usesLargeUploadPath({
        platform: "youtube",
        mimeType: mediaItem.mimeType || "video/mp4",
        sizeBytes: mediaItem.sizeBytes,
        hasState: saved !== null,
        hasStore: true,
      });

    // Check if token needs refresh. 2026-11-01 scale audit (jobs, token refresh):
    // under the per-connection lock, so a concurrent publish, the health sweep
    // or the metrics sync never refreshes the same connection at once.
    // A resumable step sends a request with the token for as long as its budget
    // lasts, so a token that expires before the deadline is refreshed first: one that
    // died mid-step would fail the upload with a 401 on a chunk.
    const tokenMustLastUntil = resumable && deadline !== undefined ? Math.max(deadline, Date.now()) : Date.now();
    if (socialConnection.expiresAt && socialConnection.expiresAt < new Date(tokenMustLastUntil)) {
      console.log("[YouTube] Access token expired, refreshing...");
      socialConnection = await refreshConnectionToken(
        socialConnection,
        (current) => refreshGoogleToken(current, { deadline }),
        { deadline },
      );
    }

    const accessToken = socialConnection.accessToken;
    if (!accessToken) {
      const error = new Error("Missing access token for YouTube") as Error & { code: string };
      error.code = "YOUTUBE_NO_ACCESS_TOKEN";
      throw error;
    }

    // YouTube only supports videos
    if (mediaItem.mimeType && !mediaItem.mimeType.startsWith("video/")) {
      console.warn("[YouTube] Attempting to upload non-video media", {
        mimeType: mediaItem.mimeType,
        originalFilename: mediaItem.originalFilename,
      });
      const error = new Error("YouTube only supports video uploads") as Error & { code: string };
      error.code = "YOUTUBE_MEDIA_NOT_VIDEO";
      throw error;
    }

    console.log("[YouTube] Starting video upload", {
      mimeType: mediaItem.mimeType,
      sizeBytes: mediaItem.sizeBytes,
      originalFilename: mediaItem.originalFilename,
    });

    if (store !== undefined && resumable) {
      return publishResumable({ ctx, accessToken, store, saved });
    }

    // Fetch the video from Vercel Blob.
    // fetchWithTimeout's own timeoutMs only bounds the connection + response
    // headers; pass AbortSignal.timeout as init.signal to also bound the
    // arrayBuffer() body transfer (see the fetchWithTimeout docstring). Both are
    // the same value, clamped to the remaining step budget; a spent budget throws
    // PUBLISH_TIME_BUDGET_EXCEEDED before the request (nothing is sent).
    const mediaUrl = mediaItem.storageLocation;
    const downloadTimeoutMs = budgetedTimeout(YOUTUBE_DOWNLOAD_TIMEOUT_MS, deadline);
    const mediaResponse = await fetchWithTimeout(
      mediaUrl,
      { signal: AbortSignal.timeout(downloadTimeoutMs) },
      downloadTimeoutMs,
    );
    await assertOk(mediaResponse, {
      code: "YOUTUBE_FETCH_MEDIA_FAILED",
      prefix: "Failed to fetch media from storage",
    });

    const videoBytes = Buffer.from(await mediaResponse.arrayBuffer());

    const { metadata, apiParts, locationData } = buildYouTubeVideoResource(ctx);

    // Create multipart upload
    const boundary = "----VibeSocialsYouTubeBoundary";
    const metadataBody = JSON.stringify(metadata);

    console.log("[YouTube] Full metadata being sent to API:", metadataBody);

    const parts = [
      `--${boundary}\r\n`,
      `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
      `${metadataBody}\r\n`,
      `--${boundary}\r\n`,
      `Content-Type: ${mediaItem.mimeType || "video/mp4"}\r\n\r\n`,
    ];

    const partBuffers = parts.map((p) => Buffer.from(p, "utf-8"));
    const endBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");

    const body = Buffer.concat([...partBuffers, videoBytes, endBoundary]);

    // 2026-11-01 scale audit (jobs H6, Review Focus 5): videos.insert is the
    // commit call. A 5xx, a timeout or a dropped connection after it was sent
    // is PUBLISH_UNCONFIRMED (the video may exist) and is never re-run; a 4xx or
    // 429 is returned and classified below as before. The timeout is clamped to
    // the step's remaining budget, and a spent budget throws
    // PUBLISH_TIME_BUDGET_EXCEEDED BEFORE the request is sent (safe to retry).
    const uploadResponse = await commitRequest("youtube", () =>
      fetchWithTimeout(
        `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=${apiParts}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": body.length.toString(),
          },
          body,
        },
        budgetedTimeout(YOUTUBE_UPLOAD_TIMEOUT_MS, deadline),
      ),
    );

    // 2026-11-01 scale audit (platform limits): quotaExceeded / uploadLimitExceeded
    // / rate limits become RATE_LIMITED (with the Pacific-midnight reset), not
    // YOUTUBE_UPLOAD_FAILED.
    const limited = await classifyRateLimit("youtube", uploadResponse);
    if (limited) throw limited;

    await assertOk(uploadResponse, {
      code: "YOUTUBE_UPLOAD_FAILED",
      prefix: "YouTube upload failed",
    });

    // The insert answered 2xx, so the video may exist (see completedUpload).
    const published = await completedUpload(uploadResponse);

    // Note: YouTube API does not support setting recordingDetails (location) via API
    // Location can only be set manually via YouTube Studio or mobile apps
    // We keep the location in our database for other platforms (Instagram, TikTok, X)
    if (locationData?.latitude && locationData?.longitude) {
      console.log("[YouTube] Location data available but cannot be set via API", {
        location: locationData,
        note: "YouTube requires manual location setting via Studio or mobile app",
      });
    }

    return published;
  },

  async refreshToken(
    connection: SocialConnection,
    opts?: { deadline?: number },
  ): Promise<SocialConnection> {
    return refreshGoogleToken(connection, opts);
  },
};
