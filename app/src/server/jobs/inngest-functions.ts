import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getPlatformClient } from "@/server/platforms";
import { publishDeadline } from "@/server/platforms/publishBudget";
import { withTransientRetries } from "@/server/platforms/transientRetry";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import {
  RETENTION_MAX_BATCHES_PER_RUN,
  sweepExpiredMediaBatch,
  type RetentionBatchResult,
  type RetentionCursor,
} from "@/server/jobs/mediaRetentionBatch";
import {
  CONNECTION_GONE_FAILURE,
  failPendingPostJobResults,
  recomputeAndStorePostJobStatus,
  type PendingResultFailure,
} from "@/server/jobs/failPendingResults";
import {
  claimDueScheduledJobs,
  MATERIALIZE_CHUNK_SIZE,
  materializeAndDispatchChunk,
  reconcileStuckInProgressJobs,
  type ChunkDispatchResult,
} from "@/server/jobs/scheduledScanner";
import {
  METRICS_MAX_PAGES_PER_RUN,
  METRICS_UNITS_PER_RUN,
} from "@/server/jobs/metricsScanner";
import {
  syncYouTubeMetricsPage,
  type MetricsPageResult,
} from "@/server/jobs/youtubeMetricsSync";
import { resolvePostCaptionSource } from "@/server/jobs/posting";
import {
  PUBLISH_PRIORITY,
  publishConcurrency,
  refreshConnectionConcurrency,
} from "@/server/jobs/publishFlowControl";
import { healResultWorkspaceIds } from "@/server/jobs/resultWorkspaceHeal";
import {
  STALE_ELIGIBLE_STATUSES,
  staleCutoff,
} from "@/server/jobs/stalePostJobs";
import { deliverPostOutcomeNotification } from "@/server/notifications/postOutcomeEmail";
import { buildReconnectEmail } from "@/server/notifications/reconnectEmail";
import { sendEmail } from "@/server/notifications/email";
import {
  HEALTH_SWEEP_PAGE_SIZE,
  isProactiveRefreshEligible,
  proactiveRefreshWhere,
} from "@/server/jobs/connectionHealthSweep";
import { platformLabel } from "@/lib/platforms";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  claimResult,
  finalizeClaimedResult,
  releaseClaimForContinuation,
  releaseClaimForDeferral,
} from "@/server/jobs/resultClaim";
import {
  deferralErrorCode,
  giveUpFailure,
  MAX_CONTINUATIONS_PER_RESULT,
  resolveContinuation,
  resolveDeferral,
  runPlatformStepsWithDeferrals,
  type PlatformStepOutcome,
  type PlatformStepPlan,
} from "@/server/jobs/platformSteps";
import {
  createUploadStateStore,
  UPLOAD_INCOMPLETE,
  YOUTUBE_UPLOAD_STATE_KIND,
} from "@/server/jobs/uploadState";
import {
  CONNECTION_GONE_CODE,
  CONNECTION_RECONNECT_REQUIRED_CODE,
  refreshConnectionToken,
} from "@/server/platforms/connectionRefresh";
import {
  currentPacificMidnight,
  isRateLimitedError,
  PACIFIC_RESET_GRACE_MS,
  rateLimitedError,
  type RateLimitedError,
} from "@/server/platforms/rateLimited";
import {
  consumeYouTubeUploadSlot,
  exhaustYouTubeUploadBudget,
} from "@/server/platforms/youtubeQuota";
import type { MediaItem, Platform, User } from "@prisma/client";
import type {
  PublishContext,
  PublishResult,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";

// Step-memoized refs only — NEVER put accessToken/refreshToken in step output
// (Inngest persists step results). Publish steps re-load secrets from the DB.
interface SerializedMediaItem {
  id: string;
  createdAt: string;
  userId: string;
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  metadata: unknown;
  perPlatformOverrides: unknown;
  deletedAt?: string | null;
}

/** Connection identity carried across steps — no OAuth secrets. */
interface ConnectionRef {
  id: string;
  platform: Platform;
}

interface PublishToPlatformArgs {
  connectionRef: ConnectionRef;
  mediaItem: SerializedMediaItem;
  /** The text to publish (override or base caption + workspace footer). */
  caption: string;
  /** The post's base caption, no footer — YouTube's title source. */
  baseCaption: string;
  userId: string;
  resultRecordId: string;
  /** The Inngest run holding the result's claim (resultClaim.ts); every write is made under it. */
  runId: string;
  /**
   * 0 for a platform's first attempt in the run, n after its n-th rate-limit wait
   * (platformSteps.ts): decides how long the next wait is, or whether to give up.
   */
  attempt: number;
  /**
   * 0 in a platform's first step of the run, n in its n-th continuation step
   * (`<stepId>-c<n>`, platformSteps.ts): a large upload that did not fit one step
   * and resumes from its saved state (uploadState.ts).
   */
  continuation: number;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

/**
 * Point a still-`pending` result at the connection that will publish it.
 * `PostJobResult.socialConnectionId` is SET NULL when its connection is removed
 * (the history outlives Disconnect / Switch account); a retry, or a publish run
 * that finds the platform reconnected since dispatch, publishes through the
 * workspace's current connection and re-links it, and a result that already
 * points there is left alone. Bookkeeping only, so a failure (e.g. the connection
 * vanished since the setup step -> FK violation) is logged and swallowed:
 * `publishToPlatform` reloads the connection itself and reports a clean
 * CONNECTION_GONE failure, which a thrown error here would pre-empt.
 */
async function repointResultConnection(
  resultRecordId: string,
  connectionId: string,
): Promise<void> {
  try {
    const current = await prisma.postJobResult.findUnique({
      where: { id: resultRecordId },
      select: { socialConnectionId: true },
    });
    if (current?.socialConnectionId === connectionId) return;
    await prisma.postJobResult.updateMany({
      where: { id: resultRecordId, status: "pending" },
      data: { socialConnectionId: connectionId },
    });
  } catch (error) {
    logger.warn("[Inngest] Could not repoint a result at the current connection", {
      resultRecordId,
      connectionId,
      error,
    });
  }
}

/**
 * Touch the job's `updatedAt`, the heartbeat the 2 h reconciler and the 6 h stale
 * sweep judge liveness by. Bookkeeping only: a failure is logged and swallowed,
 * and the claim that follows would fail the same way anyway.
 */
async function refreshJobHeartbeat(postJobId: string): Promise<void> {
  try {
    await prisma.postJob.updateMany({
      where: { id: postJobId },
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    logger.warn("[Inngest] Could not refresh the job heartbeat before a resumed step", {
      postJobId,
      error,
    });
  }
}

/**
 * Claim the platform step's result before anything touches the platform
 * (2026-11-01 scale audit, jobs H6). Run at the start of every
 * `publish-to-<platform>` and `retry-<platform>` step; returns null when this
 * run now holds the claim and may publish, else the step's final output — no
 * platform call is ever made after a non-null return.
 *
 * - `not_pending` / `held_by_other_run` -> `skipped`, nothing written. Ruling
 *   R8a (retry): an overlapping run may have finalized the result since, or an
 *   onFailure handler failed it (and the user may already have retried it
 *   again). Final review M2 (publish): `inngest.send` can throw AFTER Inngest
 *   accepted the event (e.g. a response timeout) — the route then fails the
 *   results (DISPATCH_FAILED) and answers 503, yet this run still starts. H6:
 *   two runs of one job (a duplicate event, a retry overlapping a late
 *   original) race for the same result; only the first claimant publishes.
 *   Publishing in any of these cases would overwrite `failed` with `success`
 *   or post twice.
 * - `held_by_this_run` -> this run claimed the result in an earlier attempt of
 *   the step that never recorded an outcome (the invocation died mid-call). The
 *   platform may already have the post, so it is NOT called again: the result
 *   is failed PUBLISH_UNCONFIRMED instead (Task 2's step retries rely on this).
 *
 * `attempt` > 0 is a step that follows a rate-limit wait (platformSteps.ts): the
 * result is `pending`, unclaimed and carries `deferredUntil`, and claiming it
 * ends the deferral. That wait can be most of a day, long enough for the job's
 * heartbeat (`PostJob.updatedAt`) to be older than the sweeps' windows, so the
 * heartbeat is refreshed BEFORE the claim: while the result is still deferred
 * the sweeps skip the job, and from the claim on they see a fresh heartbeat.
 *
 * `continuation` > 0 (2026-11-02 scale audit, jobs, chunked uploads) is a step
 * that resumes a large upload (`<stepId>-c<n>`). It claims exactly like attempt 0:
 * the previous step released its claim when it continued, so the result is
 * `pending` and unclaimed, and a claim this run still holds can only be a dead
 * earlier try of THIS step - `held_by_this_run`, so PUBLISH_UNCONFIRMED, as above.
 * It refreshes the heartbeat first for the same reason as a rate-limit wait.
 */
async function claimOrSkip(
  resultRecordId: string,
  runId: string,
  context: {
    step: "publish" | "retry";
    postJobId: string;
    platform: Platform;
    attempt: number;
    continuation: number;
  },
): Promise<PlatformStepOutcome | null> {
  if (context.attempt > 0 || context.continuation > 0) await refreshJobHeartbeat(context.postJobId);

  const outcome = await claimResult(resultRecordId, runId);
  if (outcome === "claimed") return null;

  const label = context.step === "retry" ? "Retry" : "Publish";
  if (outcome === "held_by_this_run") {
    logger.warn(`[Inngest] ${label} step found its own earlier claim; recording the result as unconfirmed`, {
      postJobId: context.postJobId,
      platform: context.platform,
      resultRecordId,
      runId,
    });
    await finalizeClaimedResult(resultRecordId, runId, {
      status: "failed",
      errorCode: PUBLISH_UNCONFIRMED_CODE,
      errorMessage: PUBLISH_UNCONFIRMED_MESSAGE,
    });
    return { platform: context.platform, status: "failed", error: "Publish unconfirmed" };
  }

  logger.warn(`[Inngest] ${label} step skipped: result is not claimable`, {
    postJobId: context.postJobId,
    platform: context.platform,
    resultRecordId,
    outcome,
  });
  return { platform: context.platform, status: "skipped" };
}

/**
 * A platform said it is rate-limiting this post (2026-11-01 scale audit,
 * platform limits). Decide whether to wait or to give up, and record either:
 *
 * - wait: release the claim with `deferredUntil` (resultClaim.ts) and report
 *   `deferred`; the run sleeps and calls this platform's step again
 *   (platformSteps.ts). The result stays `pending`.
 * - give up (retries spent, or the platform wants more than 26 h): finalize it
 *   failed with a message that tells the user to retry later.
 * - the claim is gone (someone failed or finished the result meanwhile): nothing
 *   to wait for, report `skipped`.
 *
 * A `youtube_quota` error that came from Google itself (not from our own counter,
 * which is already spent) trips the day's counter, so the other jobs defer to the
 * reset instead of each spending an upload that Google refuses.
 *
 * Ruling R23: Google's quota resets at midnight Pacific, but its clock may lag
 * ours. A `youtube_quota` refusal (Google's 403 or our own counter) in the first
 * `PACIFIC_RESET_GRACE_MS` of the Pacific day is that lag, not a spent budget:
 * it must NOT trip the new day's counter (which would block every workspace for
 * a day), and the wait is only until today's midnight plus the grace, not
 * tomorrow's (resolveDeferral still applies its 30 s minimum).
 */
async function deferRateLimitedResult(args: {
  error: RateLimitedError;
  attempt: number;
  platform: Platform;
  resultRecordId: string;
  runId: string;
  /** The refusal came from our own YouTube counter, not from Google. */
  fromOurBudget: boolean;
}): Promise<PlatformStepOutcome> {
  const { error, attempt, platform, resultRecordId, runId, fromOurBudget } = args;

  const now = Date.now();
  let limited = error;
  if (error.kind === "youtube_quota") {
    const lagEndsAt = currentPacificMidnight(new Date(now)).getTime() + PACIFIC_RESET_GRACE_MS;
    if (now < lagEndsAt) {
      limited = rateLimitedError(error.platform, error.kind, lagEndsAt);
    } else if (!fromOurBudget) {
      try {
        await exhaustYouTubeUploadBudget();
      } catch (exhaustError) {
        // An optimization only: Google's own refusal still applies without it.
        logger.warn("[Inngest] Could not mark the YouTube upload budget as used up", {
          error: exhaustError,
        });
      }
    }
  }

  const decision = resolveDeferral(limited, attempt, now);

  if ("giveUp" in decision) {
    const failure = giveUpFailure(platform, error.kind);
    logger.warn(`[Inngest] ${platform} kept rate-limiting; giving up`, {
      platform,
      resultRecordId,
      kind: error.kind,
      attempt,
      retryAt: limited.retryAt,
    });
    await finalizeClaimedResult(resultRecordId, runId, { status: "failed", ...failure });
    return { platform, status: "failed", error: failure.errorMessage };
  }

  const until = new Date(decision.retryAt);
  logger.warn(`[Inngest] ${platform} is rate-limiting; deferring`, {
    platform,
    resultRecordId,
    kind: error.kind,
    attempt,
    until: until.toISOString(),
  });
  const released = await releaseClaimForDeferral(resultRecordId, runId, {
    until,
    errorCode: deferralErrorCode(error.kind),
  });
  if (!released) return { platform, status: "skipped" };
  return { platform, status: "deferred", retryAt: until.toISOString() };
}

/**
 * A platform step uploaded part of a large video and has more to do
 * (2026-11-02 scale audit, jobs, chunked uploads). Its client already saved its
 * state (uploadState.ts). Decide whether another step is allowed and record it:
 *
 * - allowed: release the claim in the one write that also bumps the job heartbeat
 *   (resultClaim.ts `releaseClaimForContinuation`) and report `continue`; the run
 *   starts `<stepId>-c<n>` straight away, or sleeps first when the platform asked
 *   to wait. The result stays `pending` and holds no claim in between; no
 *   deferral or error code is recorded, so the Activity card shows no rate-limit
 *   copy.
 * - this was already the last allowed continuation (MAX_CONTINUATIONS_PER_RESULT):
 *   finalize it failed UPLOAD_INCOMPLETE. Nothing was posted: the commit call is
 *   the last thing an upload does and it never crosses a step boundary.
 * - the claim is gone (someone failed or finished the result meanwhile): nothing
 *   to continue, report `skipped`.
 *
 * The step's end time is read here, inside the step, so the memoized outcome
 * decides the order and the sleep on every replay (platformSteps.ts).
 */
async function continueUpload(args: {
  platform: Platform;
  resultRecordId: string;
  runId: string;
  continuation: number;
  resumeAt: number | null;
}): Promise<PlatformStepOutcome> {
  const { platform, resultRecordId, runId, continuation, resumeAt } = args;

  if (continuation >= MAX_CONTINUATIONS_PER_RESULT) {
    logger.warn(`[Inngest] ${platform} upload is still unfinished after ${continuation} continuation steps; failing it`, {
      platform,
      resultRecordId,
      continuation,
    });
    await finalizeClaimedResult(resultRecordId, runId, { status: "failed", ...UPLOAD_INCOMPLETE });
    return { platform, status: "failed", error: UPLOAD_INCOMPLETE.errorMessage };
  }

  const next = resolveContinuation(resumeAt, Date.now());
  const released = await releaseClaimForContinuation(resultRecordId, runId);
  if (!released) return { platform, status: "skipped" };

  logger.info(`[Inngest] ${platform} upload continues in another step`, {
    platform,
    resultRecordId,
    continuation: continuation + 1,
    sleep: next.sleep,
  });
  return { platform, status: "continue", ...next };
}

/**
 * 2026-11-02 scale audit (jobs B3): a platform error can quote a capability URL (a
 * fetch error names the URL it failed on, an upstream message can echo one), and an
 * error's message reaches the result row, the log and the step output. Every
 * http(s) URL is replaced up to the next space.
 */
const URL_IN_TEXT = /https?:\/\/\S+/gi;

function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, "[url]");
}

/**
 * A copy of `err` for the log with URLs scrubbed from its message and stack, and
 * only its `code` and `status` kept. It stays an Error so the logger still hands
 * Sentry a real exception to group on.
 */
function scrubbedError(err: Error & { code?: string; status?: unknown }): Error {
  const copy = Object.assign(new Error(scrubUrls(err.message ?? "")), {
    code: err.code,
    status: err.status,
  });
  copy.name = err.name;
  copy.stack = err.stack === undefined ? undefined : scrubUrls(err.stack);
  return copy;
}

// Helper to publish to a single platform. Loads the connection fresh so tokens
// are never serialized through step.run() memoization. The caller has already
// claimed the result for `runId` (claimOrSkip); every result write here is made
// under that claim (finalizeClaimedResult), which also bumps the job heartbeat.
// A rate limit or quota refusal is not a failure: it defers the result
// (deferRateLimitedResult) and the run waits and calls this again with the next
// `attempt`. A large upload that does not fit one step continues
// (continueUpload) and the run calls this again with the next `continuation`.
async function publishToPlatform({
  connectionRef,
  mediaItem,
  caption,
  baseCaption,
  userId,
  resultRecordId,
  runId,
  attempt,
  continuation,
  tiktokMetadata,
  youtubeMetadata,
}: PublishToPlatformArgs): Promise<PlatformStepOutcome> {
  // ONE deadline for this step, stamped before anything else and shared by
  // every in-step retry: the platform work must end inside Vercel's 300s
  // per-invocation cap with time left to record the result (publishBudget.ts).
  const deadline = publishDeadline();
  const client = getPlatformClient(connectionRef.platform);
  // Where a chunked upload keeps its progress between steps (uploadState.ts):
  // always handed to the client, built for THIS result, run and platform, so every
  // step of an upload (-c<n>, -rl<n>) sees the same state and a retry run does not.
  const uploadState = createUploadStateStore({
    resultId: resultRecordId,
    runId,
    platform: connectionRef.platform,
  });

  if (!client) {
    await finalizeClaimedResult(resultRecordId, runId, {
      status: "failed",
      errorCode: "CLIENT_NOT_FOUND",
      errorMessage: "No client configured for this platform.",
    });
    return { platform: connectionRef.platform, status: "failed", error: "No client" };
  }

  // Only the platform call (and the failures that happen before it) live in the
  // try below. Once `publishVideo` returned, the post is live: recording it is
  // done AFTER the try/catch, so a database error on that write propagates
  // instead of being caught and written down as a retryable failure (which would
  // let a retry post twice). The run then fails and onFailure marks the claimed
  // row PUBLISH_UNCONFIRMED; with Task 2's step retries the retried step finds
  // its own claim and does the same (2026-11-01 scale audit, jobs H6).
  let publishResult: PublishResult;
  // Set when the refusal below is our own YouTube counter's, not Google's.
  let refusedByOurBudget = false;
  try {
    // Reload inside the step so tokens stay in-process only (db.ts opens seals).
    const connection = await prisma.socialConnection.findUnique({
      where: { id: connectionRef.id },
    });
    if (!connection) {
      await finalizeClaimedResult(resultRecordId, runId, {
        status: "failed",
        ...CONNECTION_GONE_FAILURE,
      });
      return {
        platform: connectionRef.platform,
        status: "failed",
        error: "Connection gone",
      };
    }
    if (connection.needsReconnect) {
      await finalizeClaimedResult(resultRecordId, runId, {
        status: "failed",
        errorCode: "RECONNECT_REQUIRED",
        errorMessage: "This platform needs to be reconnected in Settings before publishing.",
      });
      return {
        platform: connectionRef.platform,
        status: "failed",
        error: "Reconnect required",
      };
    }

    logger.info(`[Inngest] Publishing to ${connection.platform}...`, {
      platform: connection.platform,
      resultRecordId,
    });
    // step.run() serializes Dates to strings on mediaItem; platform clients only
    // read fields present on both shapes (and nothing reads `user` beyond `id`).
    const publishContext: PublishContext = {
      user: { id: userId } as unknown as User,
      socialConnection: connection,
      mediaItem: mediaItem as unknown as MediaItem,
      caption,
      baseCaption,
      deadline,
      uploadState,
      continuation,
    };

    // Add TikTok metadata if publishing to TikTok
    if (connection.platform === "tiktok" && tiktokMetadata) {
      publishContext.tiktokMetadata = tiktokMetadata;
    }

    // Add YouTube metadata if publishing to YouTube
    if (connection.platform === "youtube" && youtubeMetadata) {
      publishContext.youtubeMetadata = youtubeMetadata;
    }

    // YouTube's `videos.insert` has its own daily budget (100 a day by default,
    // resetting at midnight Pacific; youtubeQuota.ts). Spend ONE slot per upload
    // SESSION, after the claim and the connection checks, so a result that never
    // reaches YouTube costs none, and OUTSIDE withTransientRetries below, so an
    // in-step retry never spends a second. With none left the API is not called:
    // the result waits for the reset (plus its grace), as a daily limit.
    //
    // 2026-11-02 scale audit (jobs, chunked uploads): a session spans several
    // steps. Only the step that starts it spends a slot; a continuation (-c<n>) and
    // a rate-limit retry (-rl<n>) of a session this run already saved, sealed, spend
    // nothing. Without a sealed session for this run - the first step, a retry run,
    // a state that was lost, or the tombstone an expired session leaves (the restart
    // count, no secret: youtubeClient.ts) - the client starts a new session, which
    // costs a slot.
    if (connection.platform === "youtube") {
      const session = await uploadState.load<unknown, unknown>(YOUTUBE_UPLOAD_STATE_KIND);
      if (session === null || session.secret === undefined) {
        const slot = await consumeYouTubeUploadSlot();
        if (!slot.allowed) {
          refusedByOurBudget = true;
          throw rateLimitedError(
            "youtube",
            "youtube_quota",
            slot.resetAt.getTime() + PACIFIC_RESET_GRACE_MS,
          );
        }
      }
    }

    // Bounded in-step retry for provably-uncommitted transient failures
    // (429/5xx, network errors that never connected). See transientRetry.ts
    // for why timeouts, mid-request connection drops and 4xx are deliberately
    // excluded. The publish functions now carry `retries: 3` (jobs M4), but a
    // retried platform step never calls the platform again: it finds its own
    // claim and records PUBLISH_UNCONFIRMED (claimOrSkip), so Inngest's retries
    // cannot double-post. Covers the user-triggered retry flow too — it also
    // funnels through publishToPlatform. A retry only starts while enough of
    // the step's budget is left (see MIN_RETRY_WINDOW_MS).
    publishResult = await withTransientRetries(
      () => client.publishVideo(publishContext),
      { deadline },
    );
  } catch (error: unknown) {
    if (isRateLimitedError(error)) {
      return deferRateLimitedResult({
        error,
        attempt,
        platform: connectionRef.platform,
        resultRecordId,
        runId,
        fromOurBudget: refusedByOurBudget,
      });
    }
    const err = error as Error & { code?: string };
    const message = scrubUrls(err.message ?? "");
    logger.error(`[Inngest] Platform ${connectionRef.platform} failed to publish`, {
      platform: connectionRef.platform,
      resultRecordId,
      code: err.code,
      error: scrubbedError(err),
    });
    await finalizeClaimedResult(resultRecordId, runId, {
      status: "failed",
      errorCode: err.code ?? "PUBLISH_FAILED",
      errorMessage: message || "Failed to publish to platform.",
    });
    return { platform: connectionRef.platform, status: "failed", error: message };
  }

  // A client that returns a post id has made its commit call: the post is live. A
  // `continuation` next to it is a client bug, and acting on it would run the
  // platform again (a second post), so the post id wins and the result is recorded
  // as the success it is.
  const postIsLive = typeof publishResult.externalPostId === "string" && publishResult.externalPostId !== "";
  if (publishResult.continuation && postIsLive) {
    logger.error(
      `[Inngest] ${connectionRef.platform} returned a continuation together with a post id; recording the post as published`,
      {
        platform: connectionRef.platform,
        resultRecordId,
        externalPostId: publishResult.externalPostId,
      },
    );
  }

  // The client made progress and has more to upload: it saved its state, so hand
  // the claim back and let the run call it again. Not a post: nothing is recorded
  // as published, and the commit call has not been made.
  if (publishResult.continuation && !postIsLive) {
    return continueUpload({
      platform: connectionRef.platform,
      resultRecordId,
      runId,
      continuation,
      resumeAt: publishResult.continuation.resumeAt,
    });
  }

  logger.info(`[Inngest] ${connectionRef.platform} success`, {
    platform: connectionRef.platform,
    externalPostId: publishResult.externalPostId,
  });
  await finalizeClaimedResult(resultRecordId, runId, {
    status: "success",
    externalPostId: publishResult.externalPostId ?? null,
  });
  return { platform: connectionRef.platform, status: "success" };
}

/**
 * Is this the job's final word? The finalize recompute yields `in_progress`
 * while any result is still `pending` (a platform waiting out a rate limit), and
 * `completed` / `failed` once none is. Only those two are worth an outcome email.
 */
function isTerminalOutcome(status: string): boolean {
  return status === "completed" || status === "failed";
}

/** Recorded on every result a dead publish/retry run left `pending` (Task 4 item 7). */
export const PUBLISH_INTERRUPTED = {
  errorCode: "PUBLISH_INTERRUPTED",
  errorMessage: "Publishing was interrupted. Please retry.",
} as const satisfies PendingResultFailure;

/** Recorded on the re-queued results of a retry whose media was removed meanwhile. */
const MEDIA_UNAVAILABLE = {
  errorCode: "MEDIA_UNAVAILABLE",
  errorMessage: "The media for this post is no longer available. Recreate the post.",
} as const satisfies PendingResultFailure;

/** The parts of Inngest's `inngest/function.failed` payload this handler reads. */
interface PublishRunFailureArgs {
  event: {
    data: {
      function_id?: string;
      run_id?: string;
      /** The ORIGINAL triggering event (`post/publish.requested` / `post/retry.requested`). */
      event: { data?: { postJobId?: unknown; platforms?: unknown } };
    };
  };
  error: unknown;
}

/** The failed run's postJobId, or null (logged) when its event carries none. */
function failedRunPostJobId({ event, error }: PublishRunFailureArgs): string | null {
  const postJobId = event.data.event.data?.postJobId;
  if (typeof postJobId === "string" && postJobId.length > 0) return postJobId;
  logger.error("[Inngest] Publish run failed without a postJobId; nothing to fail", {
    functionId: event.data.function_id,
    runId: event.data.run_id,
    error,
  });
  return null;
}

/**
 * `onFailure` for publishToAllPlatforms (Task 4 items 7 + 9). When a run dies —
 * a step that exhausted its `retries: 3` (a step killed at Vercel's 300s
 * per-invocation cap, a database error that outlasted the retries, a
 * NonRetriableError from a deterministic setup failure) — Inngest fails it
 * and the platforms not yet attempted stay `pending`: the job looked
 * "publishing" until the 2h stuck reconciler gave up on it. This fails those
 * still-`pending` results with PUBLISH_INTERRUPTED and recomputes the job's
 * status through the shared failPendingPostJobResults helper. A result a
 * platform step had already CLAIMED may be live, so the helper marks it
 * PUBLISH_UNCONFIRMED instead (2026-11-01 scale audit, jobs H6). Results that
 * already finished are untouched (a platform that went live stays live), and
 * every failed one is retryable from the UI.
 */
export async function failInterruptedPublishRun(args: PublishRunFailureArgs): Promise<void> {
  const postJobId = failedRunPostJobId(args);
  if (!postJobId) return;

  const outcome = await failPendingPostJobResults(postJobId, PUBLISH_INTERRUPTED);
  logger.warn("[Inngest] Publish run failed; interrupted results failed", {
    postJobId,
    functionId: args.event.data.function_id,
    runId: args.event.data.run_id,
    ...outcome,
    error: args.error,
  });
}

/**
 * `onFailure` for retryPlatforms (Task 4 fix round 1, ruling R8b). Same
 * cleanup as {@link failInterruptedPublishRun}, but ONLY for the platforms
 * this retry run's own event re-queued (`event.data.platforms`): another run
 * of the same job — the original publish or another retry — may still own the
 * job's other pending results, and failing those would invite a second retry
 * of a platform that is still being published. An event without platforms
 * re-queued nothing, so nothing is failed.
 */
export async function failInterruptedRetryRun(args: PublishRunFailureArgs): Promise<void> {
  const postJobId = failedRunPostJobId(args);
  if (!postJobId) return;

  const raw = args.event.data.event.data?.platforms;
  const platforms = Array.isArray(raw)
    ? raw.filter((p): p is Platform => typeof p === "string")
    : [];
  if (platforms.length === 0) {
    logger.error("[Inngest] Retry run failed without platforms; nothing to fail", {
      postJobId,
      functionId: args.event.data.function_id,
      runId: args.event.data.run_id,
      error: args.error,
    });
    return;
  }

  const outcome = await failPendingPostJobResults(postJobId, PUBLISH_INTERRUPTED, { platforms });
  logger.warn("[Inngest] Retry run failed; its interrupted results failed", {
    postJobId,
    platforms,
    functionId: args.event.data.function_id,
    runId: args.event.data.run_id,
    ...outcome,
    error: args.error,
  });
}

/**
 * Flow control + retries (2026-11-01 scale audit, jobs H6 + H1 + M4):
 * - `retries: 3` covers the DB-only steps (`fetch-data`, `finalize-job`: idempotent
 *   reads / a recompute) and the cases an in-step wrapper cannot reach: a
 *   `finalizeClaimedResult` write that fails after the platform accepted the
 *   post, and a step killed at 300 s. Both used to fail the run and mark every
 *   later platform PUBLISH_INTERRUPTED. A retried PLATFORM step meets its own
 *   claim and records PUBLISH_UNCONFIRMED instead of calling the platform again
 *   (claimOrSkip), so the retries cannot double-post. A deterministic failure
 *   ("Missing required data") throws NonRetriableError and is not retried.
 * - `idempotency` keeps one run per postJobId for 24 h, behind the stable
 *   `publish-<postJobId>` event id (posting.ts buildPublishEvent).
 * - `concurrency` is the budget shared with retryPlatforms; `priority` lets a
 *   "Post now" jump up to 10 minutes of scheduled backlog (publishFlowControl.ts).
 */
export const publishToAllPlatforms = inngest.createFunction(
  {
    id: "publish-to-all-platforms",
    name: "Publish to All Platforms",
    retries: 3,
    idempotency: "event.data.postJobId",
    concurrency: publishConcurrency(),
    priority: PUBLISH_PRIORITY,
    onFailure: failInterruptedPublishRun,
  },
  { event: "post/publish.requested" },
  async ({ event, step, runId }) => {
    const { postJobId, userId, mediaItemId, baseCaption, perPlatformOverrides, tiktokMetadata, youtubeMetadata } = event.data;

    logger.info("[Inngest] Starting background publish job", { postJobId, mediaItemId });

    // Step 1: Fetch all required data. Team Workspaces (Task 5): the job's
    // `workspaceId` is the source of truth for the connection fan-out, so the
    // job row is fetched FIRST (not inside the same Promise.all as the
    // connections query it feeds).
    //
    // SEC: step results are memoized by Inngest — never put OAuth tokens in
    // the return value. Connection refs (id + platform) only; publish steps
    // re-load tokens from the DB.
    const setupData = await step.run("fetch-data", async () => {
      const postJob = await prisma.postJob.findUnique({ where: { id: postJobId } });
      if (!postJob) {
        // Deterministic: the job row is gone, so a retry could not change it.
        throw new NonRetriableError("Missing required data");
      }

      const [user, workspace, mediaItem, socialConnections] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true },
        }),
        prisma.workspace.findUnique({
          where: { id: postJob.workspaceId },
          select: { id: true, companyWebsite: true, defaultHashtags: true },
        }),
        prisma.mediaItem.findUnique({ where: { id: mediaItemId } }),
        prisma.socialConnection.findMany({
          where: { workspaceId: postJob.workspaceId },
          select: { id: true, platform: true },
        }),
      ]);

      if (!user || !workspace || !mediaItem) {
        throw new NonRetriableError("Missing required data");
      }

      // 2026-11-02 scale audit (correctness L1): the plan below is built from
      // these rows, not from the connections - a result outlives its connection
      // (Disconnect clears `socialConnectionId`). The connection id is carried so
      // the publish step only repoints a result that does not already point at the
      // connection it publishes through. Ids only: no tokens.
      const resultRecords = await prisma.postJobResult.findMany({
        where: { postJobId },
        select: { id: true, platform: true, socialConnectionId: true },
      });

      return {
        user,
        workspace,
        mediaItem,
        socialConnections: socialConnections as ConnectionRef[],
        resultRecords,
      };
    });

    if (!setupData.socialConnections.length) {
      // 2026-11-02 scale audit (correctness L1): every connection was removed
      // after dispatch. The job used to be marked `failed` while its results stayed
      // `pending` for good (no sweep looks at a failed job). Fail them too, through
      // the shared helper: unclaimed results get CONNECTION_GONE, one a platform
      // step already claimed becomes PUBLISH_UNCONFIRMED, and the job is recomputed
      // under its row lock (`failed`, also with no results at all). No outcome email,
      // as before.
      await step.run("mark-failed-no-connections", async () => {
        await failPendingPostJobResults(postJobId, CONNECTION_GONE_FAILURE);
      });
      return { error: "No connections" };
    }

    // Team Workspaces (Task 6, controller-added scope): the footer is the
    // WORKSPACE's brand fields (companyWebsite/defaultHashtags — design §2),
    // never the acting user's — a member can publish/retry a teammate's
    // post, and the footer must stay deterministic regardless of who acts.
    const fullBaseCaption = buildCaptionWithFooter(baseCaption, setupData.workspace);
    const overrides = perPlatformOverrides as Partial<Record<Platform, string>> | null;

    // Process each platform as a separate step (allows longer execution per
    // platform). The steps are planned here and run by runPlatformStepsWithDeferrals
    // (platformSteps.ts): every platform once, in this order, then each one a
    // platform rate-limited again after its wait (2026-11-01 scale audit, platform
    // limits), so a sleeping YouTube never delays LinkedIn.
    //
    // 2026-11-02 scale audit (correctness L1): one step per RESULT row, not per
    // current connection. Disconnect keeps a job's result rows, so a connection
    // removed after dispatch used to leave its result unvisited and `pending` until
    // the sweeps. The order comes from the memoized fetch-data output, so a replay
    // plans the same step ids: results that have a connection first, in the
    // connections' order (as before), then results without one, in result order.
    const plans: PlatformStepPlan[] = [];

    for (const connection of setupData.socialConnections) {
      const resultRecord = setupData.resultRecords.find(r => r.platform === connection.platform);
      if (!resultRecord) {
        logger.error("[Inngest] No result record for platform", { postJobId, platform: connection.platform });
        continue;
      }

      const captionOverride = overrides?.[connection.platform] ?? null;
      const caption = captionOverride
        ? buildCaptionWithFooter(captionOverride, setupData.workspace)
        : fullBaseCaption;

      // Each platform upload is a separate step - this allows checkpointing
      plans.push({
        platform: connection.platform,
        stepId: `publish-to-${connection.platform}`,
        run: async (attempt, continuation) => {
          // Final review M2 + jobs H6: only the run that claims a still-`pending`
          // result publishes it — the route may already have failed it after an
          // ambiguous dispatch error, and a duplicate run may be ahead of us.
          const early = await claimOrSkip(resultRecord.id, runId, {
            step: "publish",
            postJobId,
            platform: connection.platform,
            attempt,
            continuation,
          });
          if (early) return early;

          // The result's connection may have been removed since dispatch and the
          // platform reconnected (Disconnect + connect, or Switch account): it
          // publishes through the workspace's CURRENT connection, so point it
          // there, as a retry does. A result that already points at it needs no
          // write; an output memoized before `socialConnectionId` was selected has
          // no such field, and repointResultConnection then checks the database.
          if (resultRecord.socialConnectionId !== connection.id) {
            await repointResultConnection(resultRecord.id, connection.id);
          }

          return publishToPlatform({
            connectionRef: connection,
            mediaItem: setupData.mediaItem,
            caption,
            baseCaption,
            userId,
            resultRecordId: resultRecord.id,
            runId,
            attempt,
            continuation,
            tiktokMetadata,
            youtubeMetadata,
          });
        },
      });
    }

    // Results whose platform has no connection any more. Each still gets its
    // `publish-to-<platform>` step, which claims the result like any other (so a
    // result that is no longer pending, or that another run holds, is left alone)
    // and fails it CONNECTION_GONE: nothing is published, so no platform is called.
    const plannedPlatforms = new Set<Platform>(
      setupData.socialConnections.map((connection) => connection.platform),
    );
    for (const resultRecord of setupData.resultRecords) {
      // One step per platform: `publish-to-<platform>` must stay a unique id.
      if (plannedPlatforms.has(resultRecord.platform)) continue;
      plannedPlatforms.add(resultRecord.platform);

      plans.push({
        platform: resultRecord.platform,
        stepId: `publish-to-${resultRecord.platform}`,
        run: async (attempt, continuation) => {
          const early = await claimOrSkip(resultRecord.id, runId, {
            step: "publish",
            postJobId,
            platform: resultRecord.platform,
            attempt,
            continuation,
          });
          if (early) return early;

          await finalizeClaimedResult(resultRecord.id, runId, {
            status: "failed",
            ...CONNECTION_GONE_FAILURE,
          });
          return { platform: resultRecord.platform, status: "failed", error: "Connection gone" };
        },
      });
    }

    logger.info(`[Inngest] Publishing to ${plans.length} platforms`, {
      postJobId,
      count: plans.length,
    });

    const results = await runPlatformStepsWithDeferrals(step, plans);

    // Final step: Update job status.
    // Roadmap Phase 1: the media blob is intentionally NOT deleted here anymore.
    // It persists so media can be reused/retried and browsed in the library;
    // storage is bounded by the `mediaRetentionSweep` cron instead of a
    // delete-after-every-post. Immediate posting is otherwise unchanged.
    const finalResult = await step.run("finalize-job", async () => {
      // Recompute from the AUTHORITATIVE DB results (not the in-memory `results`
      // subset) via the shared pure rule. For this all-platforms path every
      // platform just ran, so no result is `pending` and the recompute reduces
      // to the original `some(success) ? completed : failed` — behavior-
      // preserving. Reading from the DB keeps it correct if only some platforms
      // had run (the case the retry path relies on) or a step SKIPPED a result
      // something else already settled (M2) — or re-queued: a retry the user
      // started meanwhile leaves it `pending`, which reads `in_progress`.
      // Under the PostJob row lock (jobs H6): a retry run may finalize the same
      // job at the same moment. Idempotent, so Inngest may retry the step.
      const { status, successCount } = await recomputeAndStorePostJobStatus(postJobId);

      // `finalStatus` is the memoized step output of in-flight runs: keep the key.
      return { finalStatus: status, successCount };
    });

    // Roadmap Phase 6 (spec §7.2; review B1): fire-and-forget the best-effort
    // post-outcome email. `step.sendEvent` is memoized (exactly-once per finalize)
    // and only enqueues `notification.requested` — it does NOT await
    // `sendNotification` or email delivery. The try/catch is REQUIRED: once the
    // step's retries are spent, an un-swallowed enqueue transport error would
    // mark a fully-successful publish RUN as Failed (every platform already
    // published and `PostJob.status` is already written) — corrupting the signal
    // used to detect real failures. A notification must never affect posting.
    // Mirrors the try/catch scheduledPostScanner wraps its own sendEvent in.
    // The event id is scoped to this run (2026-11-01 scale audit, jobs H6): a
    // re-executed send of THIS run's notification is deduplicated, while a later
    // retry run of the job (a new outcome) still notifies.
    // Only a TERMINAL outcome is announced (fix round 1, platform limits): a
    // result still waiting out a platform limit leaves the job `in_progress`, and
    // a "YouTube: Pending" email now would be followed by a second one when it
    // settles. The decision reads the memoized finalize output, so it is the same
    // on every replay; the step id is unchanged.
    if (isTerminalOutcome(finalResult.finalStatus)) {
      try {
        await step.sendEvent("notify-outcome", {
          id: `notify-${postJobId}-${runId}`,
          name: "notification.requested",
          data: { userId, postJobId },
        });
      } catch (err) {
        logger.error("[Inngest] Failed to enqueue post-outcome notification (ignored)", { postJobId, error: err });
      }
    }

    logger.info("[Inngest] Job completed", { postJobId, ...finalResult });

    return {
      postJobId,
      status: finalResult.finalStatus,
      results,
    };
  }
);

/**
 * Roadmap Phase 1 — hourly, batched media retention sweep.
 *
 * Because blobs now persist past posting, this cron bounds Blob storage: it
 * finds *posted*, stale media that no active/scheduled job still needs, removes
 * the blob (`del` — skipped when another live MediaItem, in any workspace,
 * references the same URL), and soft-deletes the row (`deletedAt = now`, the
 * row itself is kept for history/captions). Never-posted library uploads are exempt — see
 * `isMediaSweepEligible`. The eligibility rule is re-evaluated against fresh data
 * inside the delete transaction, which NARROWS but does not fully close the
 * check-then-act race with a concurrent reuse: under Read Committed an uncommitted
 * reuse is invisible to the re-check, and the sweep's `UPDATE deletedAt` and a
 * reuse's `INSERT PostJob` take non-conflicting row locks. This is unreachable
 * today (no code attaches a PostJob to a pre-existing MediaItem). The reuse phase
 * MUST add row-level locking — `SELECT ... FOR UPDATE` on the MediaItem in BOTH
 * the sweep and the reuse path (or a Serializable transaction) — to close it.
 *
 * 2026-11-01 scale audit (jobs, media retention): the daily sweep deleted at
 * most 500 items per run while about 10,000 a day become eligible at the
 * reference load, so storage grew without bound. It now runs hourly at :15 and
 * drains the backlog in batches (mediaRetentionBatch.ts):
 *  - `sweep-batch-<i>` is one keyset-paged batch of 200 candidates, resumed from
 *    the previous batch's cursor, with its own 150 s in-step budget. A batch that
 *    comes back short (or empty) ends the run; the loop is capped at 15 batches
 *    (3,000 items an hour, about 72,000 a day, against about 10,000 a day of
 *    inflow). The step id is the loop index, so it is deterministic on replay.
 *  - the per-item transaction (FOR UPDATE, eligibility re-check, deletedAt write,
 *    deleteBlobUnlessShared) is the daily sweep's, unchanged.
 * `singleton: { mode: "skip" }` skips a tick that arrives while the previous run
 * is still draining (https://www.inngest.com/docs/guides/singleton); the next
 * hour's run starts from the beginning of the list and picks up what is left.
 * SEC: step outputs are counts and one (createdAt, id) cursor - never a
 * storageLocation.
 */
export const mediaRetentionSweep = inngest.createFunction(
  {
    id: "media-retention-sweep",
    name: "Media Retention Sweep",
    singleton: { mode: "skip" },
  },
  { cron: "15 * * * *" },
  async ({ step }) => {
    let after: RetentionCursor | null = null;
    let batches = 0;
    let candidates = 0;
    let swept = 0;
    let skipped = 0;
    let errors = 0;
    let exhausted = false;

    for (let i = 0; i < RETENTION_MAX_BATCHES_PER_RUN; i++) {
      const cursor: RetentionCursor | null = after;
      const batch: RetentionBatchResult = await step.run(`sweep-batch-${i}`, () =>
        sweepExpiredMediaBatch({ after: cursor }),
      );
      batches += 1;
      candidates += batch.candidates;
      swept += batch.swept;
      skipped += batch.skipped;
      errors += batch.errors;

      if (batch.exhausted) {
        exhausted = true;
        break;
      }
      // Not exhausted but no cursor cannot happen (a non-exhausted batch handled
      // at least one row); stop rather than restart from the beginning.
      if (!batch.next) break;
      after = batch.next;
    }

    const summary = { batches, candidates, swept, skipped, errors, exhausted };
    logger.info("[Inngest] Media retention sweep complete", summary);
    return summary;
  },
);

/**
 * Roadmap Phase 3 — retry only the named (previously failed) platforms of an
 * existing PostJob without re-running the platforms that already succeeded.
 *
 * The `POST /api/posts/[postJobId]/retry` endpoint is the ONLY producer of
 * `post/retry.requested`. It has already, atomically and per-platform, flipped
 * each eligible `PostJobResult` from `failed` -> `pending` (the conditional
 * `updateMany` that makes a double-click / concurrent retry safe — posting is
 * NOT idempotent) and set `PostJob.status = in_progress`. This function only
 * re-publishes those platforms and recomputes the job status from ALL results.
 *
 * IDEMPOTENCY: two layers keep a platform from being posted twice.
 * 1. The endpoint's conditional `failed` -> `pending` claim makes a double-click
 *    or a concurrent retry request flip each result once.
 * 2. (Ruling R8a, now the atomic claim of 2026-11-01 scale audit jobs H6) each
 *    `retry-<platform>` step claims its result and publishes only while it is
 *    `pending` and unclaimed: against ANOTHER retry run, against the original
 *    publish run (which may have finalized the result, had an onFailure fail it,
 *    or not reached its own step yet), and against Inngest's own step retries
 *    (`retries: 3`: a retried step meets its own claim and records
 *    PUBLISH_UNCONFIRMED).
 * The old per-`postJobId` concurrency key is gone: the claim replaced it as the
 * double-publish guard, and the PostJob row lock in
 * `recomputeAndStorePostJobStatus` replaced it as the guard against two runs
 * finalizing the job at once. Retry shares the publish function's per-workspace
 * and global concurrency budget (publishFlowControl.ts). It has no function
 * `idempotency`: that would swallow a legitimate second retry of one job; the
 * per-request event id (posting.ts buildRetryEvent) dedupes a re-sent request.
 *
 * Removed connections (2026-11-01 audit): a result outlives its connection
 * (`socialConnectionId` is SET NULL on Disconnect / Switch account). The retry
 * always publishes through the workspace's CURRENT connection for the platform
 * and repoints the result to it; with no usable connection the result is failed
 * with RECONNECT_REQUIRED ("no longer connected") instead of throwing.
 *
 * Caption source: unlike the initial publish (which carries caption/overrides
 * in the event payload), a retry re-derives them from the DB — the JOB's own
 * snapshot first (`PostJob.baseCaption` / `perPlatformOverrides`, written for
 * every job since the 2026-11-01 audit), the shared MediaItem only for legacy
 * jobs (`resolvePostCaptionSource`), so a retried reuse never publishes the
 * original upload's caption. Per-post TikTok/YouTube metadata is replayed from
 * the job's `publishMetadata` snapshot; when absent, each client's SAFE default
 * applies (YouTube `private` here, TikTok `SELF_ONLY`).
 */
export const retryPlatforms = inngest.createFunction(
  {
    id: "retry-platforms",
    name: "Retry Failed Platforms",
    // DB-only steps are retried; a platform step meets its own claim and
    // records PUBLISH_UNCONFIRMED instead of posting again (jobs H6 + M4).
    retries: 3,
    // Interrupted-run cleanup scoped to THIS run's platforms (Task 4 item 7,
    // ruling R8b) — the original publish run may still own the others.
    onFailure: failInterruptedRetryRun,
    // The SAME env-scoped keys as publishToAllPlatforms: one shared budget.
    concurrency: publishConcurrency(),
  },
  { event: "post/retry.requested" },
  async ({ event, step, runId }) => {
    // `event.data` is untyped (schemaless Inngest client) — assign into typed
    // locals here rather than annotating with `any`.
    const postJobId: string = event.data.postJobId;
    const userId: string = event.data.userId;
    const platforms: Platform[] = event.data.platforms ?? [];

    logger.info("[Inngest] Starting retry job", { postJobId, platforms });

    if (platforms.length === 0) {
      return { postJobId, error: "No platforms to retry" };
    }

    // Fetch everything needed for just the named platforms. Team Workspaces
    // (Task 5): the retry ROUTE already validated the job is in the caller's
    // active workspace and any member (not just the job's creator) may
    // retrieve it (design §1) — this trusted internal step no longer re-gates
    // by `userId` (which is the RETRYING member, not necessarily the job's
    // creator) and instead derives the connection fan-out from the job's own
    // `workspaceId`, mirroring `publishToAllPlatforms` above.
    //
    // SEC: connection list is id+platform only — tokens reloaded in publish step.
    const setupData = await step.run("fetch-retry-data", async () => {
      const postJob = await prisma.postJob.findUnique({ where: { id: postJobId } });
      if (!postJob) {
        return null;
      }

      const [user, workspace, mediaItem, connections, resultRecords] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true },
        }),
        prisma.workspace.findUnique({
          where: { id: postJob.workspaceId },
          select: { id: true, companyWebsite: true, defaultHashtags: true },
        }),
        prisma.mediaItem.findUnique({ where: { id: postJob.mediaItemId } }),
        prisma.socialConnection.findMany({
          where: {
            workspaceId: postJob.workspaceId,
            platform: { in: platforms },
            needsReconnect: false,
          },
          select: { id: true, platform: true },
        }),
        prisma.postJobResult.findMany({
          where: { postJobId, platform: { in: platforms } },
          select: { id: true, platform: true },
        }),
      ]);

      // Privacy snapshot once (not per platform step) for retry replay.
      const publishMetadata = postJob.publishMetadata as {
        tiktok?: TikTokPostMetadata;
        youtube?: YouTubePostMetadata;
      } | null;

      return {
        user,
        workspace,
        mediaItem,
        connections: connections as ConnectionRef[],
        resultRecords,
        publishMetadata,
        // Job-first caption (the text typed for THIS post), media fallback.
        captionSource: mediaItem ? resolvePostCaptionSource(postJob, mediaItem) : null,
      };
    });

    if (!setupData) {
      logger.error("[Inngest] Retry job not found", { postJobId });
      return { postJobId, error: "Job not found" };
    }

    const {
      user,
      workspace,
      mediaItem,
      connections,
      resultRecords,
      publishMetadata,
      captionSource,
    } = setupData;

    // The blob must still exist to re-publish. The endpoint already gates this,
    // but a concurrent retention sweep could have removed it in between — fail
    // the re-queued results deterministically so the job never hangs
    // `in_progress`, then recompute. `workspace` folds into the same
    // defensive check: the job's workspaceId is a NOT NULL FK, so a missing
    // row here means the workspace was deleted concurrently (or DB
    // corruption) — equally "shouldn't happen" as a missing user/mediaItem.
    if (!user || !workspace || !mediaItem || !captionSource || mediaItem.deletedAt !== null) {
      // Through the shared helper (2026-11-01 scale audit, jobs H6): a row
      // another run has CLAIMED (the original publish run, mid-call) may be live,
      // so it is marked PUBLISH_UNCONFIRMED - which that run's confirmed success
      // still overwrites - instead of MEDIA_UNAVAILABLE. The job is recomputed
      // over ALL results exactly as this step used to.
      await step.run("fail-media-unavailable", async () => {
        await failPendingPostJobResults(postJobId, MEDIA_UNAVAILABLE, { platforms });
      });
      return { postJobId, error: "Media unavailable" };
    }

    // Team Workspaces (Task 6, controller-added scope): footer source is the
    // JOB's workspace, not the retrying member — same reasoning as
    // publishToAllPlatforms above. `user` is kept (existence-checked above)
    // for `userId`'s continued use below; it no longer feeds the footer.
    const fullBaseCaption = buildCaptionWithFooter(captionSource.baseCaption, workspace);
    const overrides = captionSource.perPlatformOverrides;

    // Planned here, run by runPlatformStepsWithDeferrals (platformSteps.ts): each
    // platform once, then each one a platform rate-limited again after its wait.
    const plans: PlatformStepPlan[] = [];

    for (const platform of platforms) {
      const resultRecord = resultRecords.find((r) => r.platform === platform);
      if (!resultRecord) {
        // No re-queued result row for this platform — nothing to retry.
        logger.error("[Inngest] No result record to retry", { postJobId, platform });
        continue;
      }

      const connection = connections.find((c) => c.platform === platform);

      plans.push({
        platform,
        stepId: `retry-${platform}`,
        run: async (attempt, continuation): Promise<PlatformStepOutcome> => {
          // Ruling R8a + jobs H6: publish only if this run claims the result the
          // retry route re-queued as `pending`. An overlapping run may have
          // finalized it since, an onFailure handler may have failed it (and the
          // user may already have retried it again), or the original publish run
          // may get to it first — publishing then would post twice.
          const early = await claimOrSkip(resultRecord.id, runId, {
            step: "retry",
            postJobId,
            platform,
            attempt,
            continuation,
          });
          if (early) return early;

          if (!connection) {
            // The platform was disconnected since the original post (the result's
            // own `socialConnectionId` is null — SetNull keeps the row when its
            // connection is removed) and the workspace has no usable connection
            // for it now; there is no token to publish with. Fail with a
            // reconnect-shaped code so the UI can point the user at Settings.
            await finalizeClaimedResult(resultRecord.id, runId, {
              status: "failed",
              errorCode: "RECONNECT_REQUIRED",
              errorMessage:
                "This platform is no longer connected. Reconnect it in Settings and try again.",
            });
            return { platform, status: "failed", error: "No connection" };
          }

          // The result's original connection may have been removed (Disconnect /
          // Switch account -> `socialConnectionId` null) and the platform since
          // reconnected: this retry publishes through the workspace's CURRENT
          // connection, so point the result at it.
          await repointResultConnection(resultRecord.id, connection.id);

          const captionOverride = overrides?.[platform] ?? null;
          const caption = captionOverride
            ? buildCaptionWithFooter(captionOverride, workspace)
            : fullBaseCaption;

          // Replay publishMetadata from the job when present (immediate jobs now
          // snapshot it too). Fallback: safest defaults so a retry is never MORE
          // public than a missing choice (YouTube private, TikTok SELF_ONLY).
          const ytMeta =
            publishMetadata?.youtube ??
            (platform === "youtube" ? { privacyStatus: "private" as const } : undefined);
          const ttMeta = publishMetadata?.tiktok;

          return publishToPlatform({
            connectionRef: connection,
            mediaItem,
            caption,
            baseCaption: captionSource.baseCaption,
            userId,
            resultRecordId: resultRecord.id,
            runId,
            attempt,
            continuation,
            tiktokMetadata: ttMeta,
            youtubeMetadata: ytMeta,
          });
        },
      });
    }

    const results = await runPlatformStepsWithDeferrals(step, plans);

    // Recompute PostJob.status from ALL results (the retried platforms plus the
    // ones that already succeeded and were never touched) via the shared rule.
    // Under the PostJob row lock (jobs H6): another retry run, or the original
    // publish run, may finalize the same job at the same moment.
    const finalResult = await step.run("finalize-retry", async () => {
      const { status, successCount } = await recomputeAndStorePostJobStatus(postJobId);

      // `finalStatus` is the memoized step output of in-flight runs: keep the key.
      return { finalStatus: status, successCount };
    });

    // Roadmap Phase 6 (spec §7.2; review B1): same fire-and-forget hook as the
    // initial publish path above — a retry reaching a terminal state is itself a
    // new outcome worth emailing. Same REQUIRED try/catch: once the step's
    // retries are spent, an un-swallowed enqueue error would falsely fail a retry
    // run whose platforms already published. Same run-scoped event id. Same
    // terminal-only gate as the publish path: a retry that finalizes while another
    // platform of the job is still waiting out a limit (the original run asleep)
    // leaves the job `in_progress` and sends nothing; whichever run settles the
    // last result announces the outcome.
    if (isTerminalOutcome(finalResult.finalStatus)) {
      try {
        await step.sendEvent("notify-outcome", {
          id: `notify-${postJobId}-${runId}`,
          name: "notification.requested",
          data: { userId, postJobId },
        });
      } catch (err) {
        logger.error("[Inngest] Failed to enqueue post-outcome notification (ignored)", { postJobId, error: err });
      }
    }

    console.log("[Inngest] Retry job completed", { postJobId, ...finalResult });

    return { postJobId, status: finalResult.finalStatus, results };
  },
);

/**
 * Roadmap Phase 5 — cron due-scanner for scheduled posts (§6.2).
 *
 * Runs every 5 minutes, so a scheduled post goes out up to 5 minutes after its
 * time. Inngest counts one execution per run plus one per step, and its free
 * plan stops every run for the rest of the month at 50,000. Every minute with
 * two steps used 4,320 a day (~134,000 a month) with nobody posting, which would
 * have stopped all publishing mid-month (2026-11-07). Every 5 minutes with one
 * step is 576 a day. Do not go back to every minute without a paid plan.
 *
 * Atomically claims scheduled jobs whose `scheduledFor` has
 * arrived (`claimDueScheduledJobs`, scheduled → in_progress, up to
 * `DUE_SCAN_BATCH`), then materializes each claimed job's per-platform results
 * from the connections that exist NOW (`prepareDeferredPostJobDispatch` — the
 * review's run-time-result fix, §6.3) and hands off to the SAME
 * `post/publish.requested` / `publishToAllPlatforms` path immediate posts use
 * (which is untouched and stays short-lived / freely deployable — no long
 * `sleepUntil` inside it).
 *
 * 2026-11-01 scale audit (jobs H6): the claimed jobs are processed in chunks of
 * `MATERIALIZE_CHUNK_SIZE` (50), not one at a time. A per-job `materialize-<id>`
 * step plus a per-job `publish-<id>` send made a 500-post burst take many
 * minutes and a full tick 2,002 steps against Inngest's 1,000-step run limit
 * (https://www.inngest.com/docs/usage-limits/inngest). Per chunk `<i>`:
 *  - `materialize-dispatch-batch-<i>` (`materializeAndDispatchChunk`) materializes
 *    the chunk's jobs and sends their publish events with `inngest.send`, in
 *    sub-batches bounded by `MAX_DISPATCH_BYTES`. It is ONE step so the events
 *    (user text nothing caps: a single caption can be megabytes) never become
 *    memoized step output; the step returns only counts and ids. A re-run is safe:
 *    materialize is idempotent (results are created only if none exist yet), each
 *    event has the stable id `publish-<postJobId>`, and `publishToAllPlatforms`
 *    has `idempotency: event.data.postJobId`, so a second send of an event THIS
 *    code sent triggers no run. That dedupe covers only events sent by this code:
 *    events the pre-phase-2 scanner sent carry no id, which is why the release
 *    runbook (docs/STAGING_SETUP.md, "Releasing pipeline changes (Inngest)")
 *    pauses the scanner around deploys.
 *  - `notify-noconn-batch-<i>` is one `step.sendEvent` of the owner notifications
 *    for jobs that had no connection at run time (marked `failed` inside the
 *    chunk step, mirroring the existing no-connections path; reuses the same
 *    `notification.requested` → `sendNotification` →
 *    `deliverPostOutcomeNotification` path every other outcome uses, so the
 *    user's `notifyOnPostComplete` preference gates it identically). Each event
 *    has the id `notify-noconn-<postJobId>`.
 * That is at most 1 + 2 x 20 steps for a full tick of 1000.
 *
 * `singleton: { mode: "skip" }` skips a tick while the previous scan is still
 * running (https://www.inngest.com/docs/guides/singleton). A skipped tick is
 * harmless: the next one claims whatever is due.
 */
export const scheduledPostScanner = inngest.createFunction(
  {
    id: "scheduled-post-scanner",
    name: "Scheduled Post Scanner",
    singleton: { mode: "skip" },
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // One step, so an idle tick costs 2 executions (the run and this step). The
    // step id and its string[] result are unchanged from the two-step version, so
    // a run that straddles a deploy replays the same memoized claim.
    const claimedIds = await step.run("claim-due-jobs", async () => {
      // Reconcile jobs stuck in_progress after a materialize/dispatch crash
      // (leaves no pending work and never reaches finalize). It runs BEFORE the
      // claim: if the step died after the claim's UPDATE but before returning,
      // the claimed ids would be lost, so the claim must be the step's last act.
      // A reconcile failure is only logged; recovery must never stop publishing,
      // and the next tick tries again.
      try {
        const reconciled = await reconcileStuckInProgressJobs(new Date());
        if (reconciled.reconciled > 0) {
          logger.info("[Inngest] Reconciled stuck in_progress jobs", reconciled);
        }
      } catch (error) {
        logger.error("[Inngest] Reconciling stuck in_progress jobs failed (claiming anyway)", { error });
      }

      return claimDueScheduledJobs(new Date());
    });

    let dispatched = 0;
    let failedNoConnections = 0;
    let dispatchErrors = 0;

    const chunkCount = Math.ceil(claimedIds.length / MATERIALIZE_CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunkIds = claimedIds.slice(
        chunkIndex * MATERIALIZE_CHUNK_SIZE,
        (chunkIndex + 1) * MATERIALIZE_CHUNK_SIZE,
      );

      // Isolate each chunk (review Minor #1): a step that throws even after
      // Inngest exhausts its retries must not abort the whole scan and strand
      // every LATER chunk (already flipped to in_progress, so the next tick —
      // which only re-queries `scheduled` — never re-claims them). Catching the
      // terminal step error here bounds the blast radius to the one failing
      // chunk and lets the rest dispatch.
      let chunk: ChunkDispatchResult;
      try {
        chunk = await step.run(`materialize-dispatch-batch-${chunkIndex}`, async () => {
          // The scanner is not "Post now": the chunk builds its events with
          // `immediate: false`, which keeps the runs at priority 0 behind
          // user-triggered publishes.
          return materializeAndDispatchChunk(chunkIds, {
            send: (events) => inngest.send(events),
          });
        });
      } catch (error) {
        // Per-job materialize errors and rejected sends are caught INSIDE the
        // step, so reaching here means the step itself died (e.g. it timed out
        // or the platform killed it). Which of its jobs were already sent is
        // unknown; they all stay in_progress, and the stuck-job reconciler
        // finalizes any that never got a run. Surfaced loudly for reconciliation
        // rather than silently marked failed, which would mislabel a transient
        // outage.
        logger.error("[Inngest] Scheduled materialize-and-dispatch step failed", {
          chunkIndex,
          jobs: chunkIds.length,
          error,
        });
        dispatchErrors += chunkIds.length;
        continue;
      }

      dispatched += chunk.dispatched;
      // Jobs whose send was rejected, and jobs that threw on every materialize
      // attempt, stay in_progress for the reconciler.
      dispatchErrors += chunk.dispatchErrors + chunk.errorIds.length;
      failedNoConnections += chunk.noConnections.length;
      if (chunk.notFound.length > 0) {
        logger.warn("[Inngest] Claimed scheduled jobs no longer exist", { postJobIds: chunk.notFound });
      }

      if (chunk.noConnections.length > 0) {
        // Phase-6 gap closed: the unattended "no platforms connected" failure
        // notifies like every other outcome. Memoized step => exactly-once.
        try {
          await step.sendEvent(
            `notify-noconn-batch-${chunkIndex}`,
            chunk.noConnections.map(({ postJobId, userId }) => ({
              id: `notify-noconn-${postJobId}`,
              name: "notification.requested" as const,
              data: { userId, postJobId },
            })),
          );
        } catch (error) {
          logger.error("[Inngest] Scheduled no-connections notification failed", {
            chunkIndex,
            events: chunk.noConnections.length,
            error,
          });
          dispatchErrors += chunk.noConnections.length;
        }
      }
    }

    console.log("[Inngest] Scheduled post scan complete", {
      claimed: claimedIds.length,
      dispatched,
      failedNoConnections,
      dispatchErrors,
    });

    return { claimed: claimedIds.length, dispatched, failedNoConnections, dispatchErrors };
  },
);

/**
 * Roadmap Phase 6 — sends the best-effort post-outcome email (spec §7.2).
 *
 * Triggered by `notification.requested`, sent fire-and-forget from the
 * `publishToAllPlatforms` / `retryPlatforms` finalize steps above via
 * `step.sendEvent` — which only enqueues and does NOT await this function.
 * All of its real work is delegated to `deliverPostOutcomeNotification`, which
 * is itself fully env-gated (no-ops with no DB access when `RESEND_API_KEY` is
 * unset) and swallows everything except a RETRYABLE delivery failure. This
 * function's job is the Inngest entry point + step-memoization boundary.
 *
 * 2026-11-01 scale audit (jobs, notifications): a burst of outcome emails used to
 * pass Resend's 10 requests/s team limit and be dropped silently.
 *  - `throttle` caps run STARTS at 8/s (V5; excess runs queue, they are not
 *    dropped), leaving 2/s of the team limit for the auth, approval and reconnect
 *    mail sent outside Inngest (V18).
 *  - A Resend 429 / 5xx / network error now throws inside `deliver-notification`
 *    (a `RetryAfterError` or `EmailRetryableError`, V8), so Inngest retries the
 *    step: `retries: 4` instead of 1.
 *  - Duplicates: the send is the LAST action of the single memoized
 *    `deliver-notification` step, so no later step can re-run it. A retry re-runs
 *    the step only when the send threw (nothing was sent) or its ack was lost, and
 *    Resend's `Idempotency-Key` (`post-outcome/<runId>`, kept 24 h, V18) makes the
 *    lost-ack case a no-op. The run id is stable across retries of one run, and a
 *    later run of the same job (a retry of failed platforms) is a new outcome.
 */
export const sendNotification = inngest.createFunction(
  {
    id: "send-notification",
    name: "Send Post Outcome Notification",
    retries: 4,
    // Resend allows 10 req/s per team (V18); 8/s leaves 2/s for the mail sent outside Inngest.
    throttle: { limit: 8, period: "1s", burst: 1 },
  },
  { event: "notification.requested" },
  async ({ event, step, runId }) => {
    // `event.data` is untyped (schemaless Inngest client) — assign into typed
    // locals here rather than annotating with `any` (mirrors retryPlatforms).
    const userId: string = event.data.userId;
    const postJobId: string = event.data.postJobId;

    // At-least-once: if the email sends but Inngest loses the step ack, the retry
    // re-runs this step, and Resend dedupes the repeat by this key (no second email).
    await step.run("deliver-notification", async () => {
      await deliverPostOutcomeNotification({
        userId,
        postJobId,
        idempotencyKey: `post-outcome/${runId}`,
      });
    });

    return { postJobId };
  },
);

/**
 * Roadmap Phase 8 — hourly YouTube post-metrics sync (analytics, §7.3).
 *
 * Best-effort, isolated per item, and STRICTLY read-only w.r.t. posting: this
 * cron only reads engagement counts and upserts `PostMetric` rows (plus stamps
 * `PostJobResult.metricsCheckedAt`) - it never touches PostJob/PostJobResult
 * status or re-publishes anything, so it cannot affect posting.
 *
 * 2026-11-01 scale audit (jobs, YouTube metrics): it used to refresh the newest
 * 100 results globally, one `videos.list` call per video, so older videos stopped
 * being refreshed. It now works through the results LEAST RECENTLY CHECKED first
 * (metricsScanner.ts), in pages (youtubeMetricsSync.ts):
 *  - `sync-page-<i>` is one page of up to 200 results, grouped per workspace
 *    connection and fetched 50 ids per call (1 quota unit a call, V9). The step id
 *    is the loop index, so it is deterministic on replay.
 *  - the run has a budget of 300 units (7,200 a day of the shared 10,000-unit
 *    general bucket) and at most 10 pages. It ends early on a page that attempted
 *    nothing (the queue is drained), or on a quota refusal (`stop`), or when the
 *    units are spent. The units left come from the previous pages' step outputs,
 *    so a replay computes the same value.
 * `singleton: { mode: "skip" }` skips a tick that arrives while the previous run
 * is still going (https://www.inngest.com/docs/guides/singleton): two overlapping
 * runs would select the same pages and spend the quota twice. A run's work is
 * resumable by design - what a run did not reach is still the stalest next hour.
 *
 * Tokens are refreshed via the shared Google helper under the per-connection lock
 * (writes only accessToken/expiry, never refreshToken); a gone / `needsReconnect`
 * connection is skipped, not hammered. SEC: step outputs are counts only.
 *
 * v1 = YouTube ONLY (see the extension point in youtubeMetricsSync.ts).
 */
export const youtubePostMetricsSync = inngest.createFunction(
  {
    id: "youtube-post-metrics-sync",
    name: "YouTube Post Metrics Sync",
    singleton: { mode: "skip" },
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    let unitsLeft = METRICS_UNITS_PER_RUN;
    let pages = 0;
    let attempted = 0;
    let updated = 0;
    let notFound = 0;
    let errors = 0;
    let unitsUsed = 0;
    let stopped = false;

    for (let i = 0; i < METRICS_MAX_PAGES_PER_RUN; i++) {
      const budget = unitsLeft;
      const page: MetricsPageResult = await step.run(`sync-page-${i}`, () =>
        syncYouTubeMetricsPage({ unitsLeft: budget }),
      );
      pages += 1;
      attempted += page.attempted;
      updated += page.updated;
      notFound += page.notFound;
      errors += page.errors;
      unitsUsed += page.unitsUsed;
      unitsLeft -= page.unitsUsed;

      if (page.stop) {
        stopped = true;
        break;
      }
      // Nothing attempted: the queue is drained (or the budget was already gone).
      if (page.attempted === 0 || unitsLeft <= 0) break;
    }

    const summary = { pages, attempted, updated, notFound, errors, unitsUsed, stopped };
    logger.info("[Inngest] YouTube metrics sync complete", summary);
    return summary;
  },
);

/**
 * Hourly sweep that gives dispatched PostJobs a terminal state.
 *
 * A job relies on an Inngest event to carry it from `pending`/`in_progress` to
 * `completed`/`failed`. When that event is lost — as it was for ten prod jobs
 * around the January Inngest key rotation — nothing else ever moves the row:
 * `retry` operates on failed PostJobResult rows and an orphan has none (so it
 * 409s), the UI shows it publishing forever, and because those statuses are
 * non-terminal the media retention sweep can never reclaim the blob.
 *
 * Marking them `failed` is the honest terminal state: we did try, and it did
 * not publish. `cancelled` would claim the user stopped it. There is nowhere to
 * record *why* — the per-platform error lives on PostJobResult and an orphan has
 * none — so these surface exactly like the other resultless failures already in
 * prod. Runs at :30 to stay clear of the metrics sync on the hour.
 *
 * Steps: `fail-stale-post-jobs`, then `heal-result-workspace` (2026-11-01 scale
 * audit, db M5): copies the job's workspace onto up to 1,000 results that the
 * previous deployment created without one (resultWorkspaceHeal.ts). The heal is
 * housekeeping, so its error is logged and never fails the sweep.
 */
export const stalePostJobSweep = inngest.createFunction(
  {
    id: "stale-post-job-sweep",
    name: "Stale Post Job Sweep",
    // One sweep at a time (2026-11-01 scale audit, platform limits): a tick that
    // arrives while the previous sweep is still running is skipped, the next
    // hour's catches whatever is left (https://www.inngest.com/docs/guides/singleton).
    singleton: { mode: "skip" },
  },
  { cron: "30 * * * *" },
  async ({ step }) => {
    const summary = await step.run("fail-stale-post-jobs", async () => {
      const cutoff = staleCutoff(new Date());

      // The eligibility rule is isStalePostJob(); expressed here as the
      // equivalent WHERE so one statement claims the rows atomically. `updatedAt`
      // (not `createdAt`) is the progress signal — a job still working through
      // its platforms bumps it as each platform finishes (finalizeClaimedResult's
      // heartbeat) and so keeps resetting its clock.
      //
      // A job with a pending result that is waiting out a platform rate limit or
      // quota (`deferredUntil` still ahead, or ended less than 6 h ago) is not
      // stale: its run is asleep, and the wait can be most of a day (2026-11-01
      // scale audit, platform limits; Review Focus 2). The run's claim at wake-up
      // clears `deferredUntil` and refreshes the heartbeat, so a job whose run
      // died stays eligible once the wait is over.
      const { count } = await prisma.postJob.updateMany({
        where: {
          status: { in: [...STALE_ELIGIBLE_STATUSES] },
          updatedAt: { lt: cutoff },
          results: { none: { status: "pending", deferredUntil: { gte: cutoff } } },
        },
        data: { status: "failed" },
      });

      if (count > 0) {
        logger.warn("[StaleSweep] failed stale in-flight post jobs", {
          count,
          cutoff: cutoff.toISOString(),
        });
      }
      return { swept: count, cutoff: cutoff.toISOString() };
    });

    const heal = await step.run("heal-result-workspace", async () => {
      try {
        const { healed } = await healResultWorkspaceIds();
        if (healed > 0) {
          logger.info("[StaleSweep] healed results without a workspaceId", { healed });
        }
        return { healed };
      } catch (error) {
        // A failed heal must not fail (or retry) the stale-job sweep; the next
        // hourly run takes the same rows.
        logger.error("[StaleSweep] could not heal PostJobResult.workspaceId", { error });
        return { healed: 0 };
      }
    });

    return { ...summary, healed: heal.healed };
  },
);

/**
 * Daily connection-health sweep (publish-reliability plan, Task 2; fanned out by
 * the 2026-11-01 scale audit, jobs, token refresh).
 *
 * Proactively refreshes every healthy connection whose access token is expired
 * or expiring within 24h (Google: idle for about 7 days - see
 * GOOGLE_IDLE_REFRESH_MS). Two effects: (1) provider refresh-tokens stay alive
 * (Google revokes grants unused for ~6 months - exactly how the prod GBP
 * connection died on 2026-07-26), and (2) a dead grant is discovered TODAY,
 * flips `needsReconnect`, and every workspace OWNER gets ONE reconnect email -
 * instead of the user discovering it when a scheduled post fails.
 *
 * Why a fan-out: the first version loaded every connection and refreshed ~8,600
 * tokens one after another in ONE 300 s step, which never finished. The cron now
 * only PAGES connection ids and sends one `connection/refresh.requested` event
 * per connection to `refresh-connection` (below), which Inngest runs under its
 * own concurrency limits. Steps:
 *  - `start` returns the ISO `now`. Every page's WHERE and the event ids derive
 *    from it, so a page that runs after UTC midnight still dedupes with its
 *    siblings.
 *  - `page-<i>` reads up to HEALTH_SWEEP_PAGE_SIZE ids (`select: { id: true }`:
 *    no token column is ever loaded), ordered by id. Page N resumes with the
 *    keyset condition `id > <last id of page N-1>` AND the sweep's WHERE - NOT a
 *    Prisma `cursor` + `skip: 1`: a cursor row that stops matching the WHERE (it
 *    was refreshed since the previous page) would make `skip: 1` drop the next
 *    real row, and a deleted cursor row returns an empty page and ends the sweep
 *    early. With `id >` the position is just a value, so rows that change or
 *    disappear between pages cannot lose or skip any other row.
 *  - `fan-out-<i>` sends that page's events. Each event id is
 *    `refresh-<id>-<UTC YYYY-MM-DD>`, so a re-run of the cron the same day
 *    sends nothing twice (event ids are an idempotency key over 24 h, V1).
 * A page shorter than HEALTH_SWEEP_PAGE_SIZE is the last: no further query.
 *
 * `singleton: { mode: "skip" }` skips a tick that arrives while the previous
 * sweep is still running (https://www.inngest.com/docs/guides/singleton).
 *
 * Email exactly-once: eligibility requires `needsReconnect === false`, so a
 * connection that flips is skipped by every later sweep; a transient failure
 * leaves the flag false, sends nothing, and is simply retried tomorrow. Cron slot
 * 04:45 UTC - cadence map: media-retention hourly :15, scheduled-scanner every
 * minute, youtube-metrics hourly :00, stale-post-sweep hourly :30.
 *
 * SEC: step outputs are ids and counts only - never connection rows (tokens).
 */
export const connectionHealthSweep = inngest.createFunction(
  {
    id: "connection-health-sweep",
    name: "Connection Health Sweep",
    singleton: { mode: "skip" },
  },
  { cron: "45 4 * * *" },
  async ({ step }) => {
    const startedAt: string = await step.run("start", () => new Date().toISOString());
    const now = new Date(startedAt);
    const day = startedAt.slice(0, 10); // UTC YYYY-MM-DD

    let pages = 0;
    let connections = 0;
    let cursor: string | undefined;

    for (let page = 0; ; page++) {
      const ids: string[] = await step.run(`page-${page}`, async () => {
        const eligible = proactiveRefreshWhere(now);
        const rows = await prisma.socialConnection.findMany({
          where: cursor ? { AND: [eligible, { id: { gt: cursor } }] } : eligible,
          select: { id: true },
          orderBy: { id: "asc" },
          take: HEALTH_SWEEP_PAGE_SIZE,
        });
        return rows.map((row) => row.id);
      });
      pages++;

      if (ids.length > 0) {
        await step.sendEvent(
          `fan-out-${page}`,
          ids.map((id) => ({
            id: `refresh-${id}-${day}`,
            name: "connection/refresh.requested" as const,
            data: { socialConnectionId: id },
          })),
        );
        connections += ids.length;
      }

      if (ids.length < HEALTH_SWEEP_PAGE_SIZE) break;
      cursor = ids[ids.length - 1];
    }

    const summary = { pages, connections };
    logger.info("[Inngest] Connection health sweep fanned out", summary);
    return summary;
  },
);

/** What one `refresh-connection` run did (the `refresh` step's output). */
export type ConnectionRefreshOutcome =
  | "refreshed"
  | "flagged"
  | "already_flagged"
  | "not_eligible"
  | "gone"
  | "no_refresh"
  | "transient_error";

/**
 * Refresh one connection for the health sweep (the body of the `refresh` step).
 * Never throws for a refresh failure: it is classified instead, so a dead
 * grant or a blip is data, not a failed run. Returns only a label - never a
 * row, token or address.
 */
async function refreshOneConnection(socialConnectionId: string): Promise<ConnectionRefreshOutcome> {
  const connection = await prisma.socialConnection.findUnique({ where: { id: socialConnectionId } });
  if (!connection) return "gone";
  // Flagged since the cron paged it (a failed post, an earlier sweep): its owner
  // is already notified, and re-refreshing a dead grant would only re-fail.
  if (connection.needsReconnect) return "already_flagged";
  // The rule is re-checked now: the event may have waited in the queue while a
  // publish or the metrics sync refreshed the connection.
  if (!isProactiveRefreshEligible(connection, new Date())) return "not_eligible";
  const client = getPlatformClient(connection.platform);
  if (!client?.refreshToken) return "no_refresh";
  const refreshToken = client.refreshToken.bind(client);

  const deadline = publishDeadline();
  try {
    await refreshConnectionToken(connection, (current) => refreshToken(current, { deadline }), {
      deadline,
    });
    return "refreshed";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === CONNECTION_GONE_CODE) return "gone";
    // Flagged by someone else while we waited for the lock: they own the email.
    if (code === CONNECTION_RECONNECT_REQUIRED_CODE) return "already_flagged";

    // A terminal failure flipped needsReconnect inside the refresher
    // (markConnectionNeedsReconnect); a transient one did not. Re-read the flag to
    // tell them apart - the owners are emailed ONLY on the flip.
    const after = await prisma.socialConnection.findUnique({
      where: { id: socialConnectionId },
      select: { needsReconnect: true },
    });
    if (!after) return "gone";
    if (after.needsReconnect) return "flagged";
    logger.warn("[Inngest] Connection refresh failed transiently; retried by the next sweep", {
      socialConnectionId,
      platform: connection.platform,
      code: typeof code === "string" ? code : undefined,
    });
    return "transient_error";
  }
}

/**
 * Email every owner of the connection's workspace that it needs reconnecting
 * (the body of the `notify-owners` step). Re-checks the flag so an owner who
 * reconnected between the two steps is not told to. Returns a COUNT only.
 *
 * 2026-11-01 scale audit (jobs, notifications): a retryable Resend failure now
 * throws out of the step (the function's `retries` re-run it) instead of being
 * dropped; the per-owner idempotency key keeps the owners already emailed from
 * being emailed again on that retry.
 *
 * 2026-11-02 scale audit (jobs, notifications): the UTC day in that key is an
 * argument (the memoized `notify-day` step), not read from the clock here: a
 * retry after midnight UTC would otherwise build a new key and email the owners
 * already emailed before midnight a second time.
 */
async function notifyOwnersToReconnect(
  socialConnectionId: string,
  utcDay: string,
): Promise<{ emailed: number }> {
  const connection = await prisma.socialConnection.findUnique({
    where: { id: socialConnectionId },
    select: { platform: true, workspaceId: true, needsReconnect: true },
  });
  if (!connection?.needsReconnect) return { emailed: 0 };

  const [workspace, owners] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: connection.workspaceId },
      select: { name: true },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: connection.workspaceId, role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    }),
  ]);
  const email = buildReconnectEmail({
    platformLabel: platformLabel(connection.platform),
    workspaceName: workspace?.name ?? "your workspace",
    appBaseUrl: process.env.NEXTAUTH_URL || null,
  });
  // One reconnect email per owner per connection per UTC day. A retry of this step
  // (or a lost ack) re-sends with the same key, which Resend treats as a no-op for
  // owners already emailed (V18). `utcDay` is the memoized output of the `notify-day`
  // step, so a retry that crosses UTC midnight still builds the same key.
  let emailed = 0;
  for (const owner of owners) {
    // A retryable failure (Resend 429 / 5xx / network) throws, failing the step so
    // Inngest retries it; every other failure is logged and dropped.
    await sendEmail(
      { to: owner.user.email, ...email },
      {
        idempotencyKey: `reconnect/${socialConnectionId}/${utcDay}/${owner.user.id}`,
        throwOnRetryable: true,
      },
    );
    emailed++;
  }
  return { emailed };
}

/**
 * Refresh ONE connection for the daily health sweep (2026-11-01 scale audit,
 * jobs, token refresh). Triggered by `connection/refresh.requested`
 * `{ socialConnectionId }`, sent by `connectionHealthSweep` (one per eligible
 * connection, event id `refresh-<id>-<UTC date>`).
 *
 * `concurrency` (at most two constraints per function, V3): one run per
 * connection (the refresh itself is also serialized by the Postgres advisory lock
 * in connectionRefresh.ts, which covers publishes and the metrics sync too), and
 * 10 refreshes in flight overall so the fan-out cannot stampede the platforms'
 * token endpoints. `retries: 2` covers infrastructure failures (the DB); a
 * failed refresh is classified in the step, not thrown.
 *
 * Steps (ids are additive and deterministic):
 *  - `refresh` returns a label: "refreshed", "flagged" (THIS refresh flipped
 *    needsReconnect), "already_flagged", "not_eligible", "gone", "no_refresh"
 *    (the platform has nothing to refresh) or "transient_error" (retried by
 *    tomorrow's sweep, no email).
 *  - `notify-day` and `notify-owners` run only on "flagged". `notify-day`
 *    memoizes the UTC date used in the reconnect idempotency keys;
 *    `notify-owners` emails each workspace owner once.
 * SEC: step outputs are labels and counts only - never tokens or addresses.
 */
export const refreshConnection = inngest.createFunction(
  {
    id: "refresh-connection",
    name: "Refresh Connection",
    retries: 2,
    concurrency: refreshConnectionConcurrency(),
  },
  { event: "connection/refresh.requested" },
  async ({ event, step }) => {
    // `event.data` is untyped (schemaless Inngest client).
    const socialConnectionId: string = event.data.socialConnectionId;

    const outcome: ConnectionRefreshOutcome = await step.run("refresh", () =>
      refreshOneConnection(socialConnectionId),
    );

    let emailed = 0;
    if (outcome === "flagged") {
      // Memoized so every attempt of `notify-owners` uses the same day (and so the
      // same idempotency keys), even across UTC midnight.
      const utcDay: string = await step.run("notify-day", () =>
        new Date().toISOString().slice(0, 10),
      );
      const notified = await step.run("notify-owners", () =>
        notifyOwnersToReconnect(socialConnectionId, utcDay),
      );
      emailed = notified.emailed;
    }

    return { socialConnectionId, outcome, emailed };
  },
);

export const inngestFunctions = [
  publishToAllPlatforms,
  mediaRetentionSweep,
  retryPlatforms,
  scheduledPostScanner,
  sendNotification,
  youtubePostMetricsSync,
  stalePostJobSweep,
  connectionHealthSweep,
  refreshConnection,
];
