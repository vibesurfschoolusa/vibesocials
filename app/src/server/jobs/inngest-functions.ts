import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getPlatformClient } from "@/server/platforms";
import { publishDeadline } from "@/server/platforms/publishBudget";
import { withTransientRetries } from "@/server/platforms/transientRetry";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import { deleteBlobUnlessShared } from "@/server/jobs/mediaBlob";
import {
  RETENTION_DAYS,
  TERMINAL_POST_JOB_STATUSES,
  isMediaSweepEligible,
} from "@/server/jobs/mediaRetention";
import {
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
  METRICS_SYNC_BATCH,
  selectYouTubeMetricEligibleResults,
} from "@/server/jobs/metricsScanner";
import { resolvePostCaptionSource } from "@/server/jobs/posting";
import { PUBLISH_PRIORITY, publishConcurrency } from "@/server/jobs/publishFlowControl";
import {
  STALE_ELIGIBLE_STATUSES,
  staleCutoff,
} from "@/server/jobs/stalePostJobs";
import { deliverPostOutcomeNotification } from "@/server/notifications/postOutcomeEmail";
import { buildReconnectEmail } from "@/server/notifications/reconnectEmail";
import { sendEmail } from "@/server/notifications/email";
import { isProactiveRefreshEligible } from "@/server/jobs/connectionHealthSweep";
import { platformLabel } from "@/lib/platforms";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  claimResult,
  finalizeClaimedResult,
  releaseClaimForDeferral,
} from "@/server/jobs/resultClaim";
import {
  deferralErrorCode,
  giveUpFailure,
  resolveDeferral,
  runPlatformStepsWithDeferrals,
  type PlatformStepOutcome,
  type PlatformStepPlan,
} from "@/server/jobs/platformSteps";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";
import {
  isRateLimitedError,
  PACIFIC_RESET_GRACE_MS,
  rateLimitedError,
  type RateLimitedError,
} from "@/server/platforms/rateLimited";
import {
  consumeYouTubeUploadSlot,
  exhaustYouTubeUploadBudget,
} from "@/server/platforms/youtubeQuota";
import { fetchYouTubeVideoStatistics, hasAnyStatistic } from "@/server/platforms/youtubeMetrics";
import { Prisma } from "@prisma/client";
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
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

/**
 * Point a still-`pending` result at the connection that will publish it.
 * `PostJobResult.socialConnectionId` is SET NULL when its connection is removed
 * (the history outlives Disconnect / Switch account); a retry through the
 * workspace's current connection re-links it, and a result that already points
 * there is left alone. Bookkeeping only, so a failure (e.g. the connection
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
    logger.warn("[Inngest] Could not repoint a retried result at the current connection", {
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
    logger.warn("[Inngest] Could not refresh the job heartbeat after a rate-limit wait", {
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
 */
async function claimOrSkip(
  resultRecordId: string,
  runId: string,
  context: { step: "publish" | "retry"; postJobId: string; platform: Platform; attempt: number },
): Promise<PlatformStepOutcome | null> {
  if (context.attempt > 0) await refreshJobHeartbeat(context.postJobId);

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
 * - give up (retries spent, or the platform wants more than 24 h): finalize it
 *   failed with a message that tells the user to retry later.
 * - the claim is gone (someone failed or finished the result meanwhile): nothing
 *   to wait for, report `skipped`.
 *
 * A `youtube_quota` error that came from Google itself (not from our own counter,
 * which is already spent) trips the day's counter, so the other jobs defer to the
 * reset instead of each spending an upload that Google refuses.
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

  if (error.kind === "youtube_quota" && !fromOurBudget) {
    try {
      await exhaustYouTubeUploadBudget();
    } catch (exhaustError) {
      // An optimization only: Google's own refusal still applies without it.
      logger.warn("[Inngest] Could not mark the YouTube upload budget as used up", {
        error: exhaustError,
      });
    }
  }

  const decision = resolveDeferral(error, attempt, Date.now());

  if ("giveUp" in decision) {
    const failure = giveUpFailure(platform, error.kind);
    logger.warn(`[Inngest] ${platform} kept rate-limiting; giving up`, {
      platform,
      resultRecordId,
      kind: error.kind,
      attempt,
      retryAt: error.retryAt,
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

// Helper to publish to a single platform. Loads the connection fresh so tokens
// are never serialized through step.run() memoization. The caller has already
// claimed the result for `runId` (claimOrSkip); every result write here is made
// under that claim (finalizeClaimedResult), which also bumps the job heartbeat.
// A rate limit or quota refusal is not a failure: it defers the result
// (deferRateLimitedResult) and the run waits and calls this again with the next
// `attempt`.
async function publishToPlatform({
  connectionRef,
  mediaItem,
  caption,
  baseCaption,
  userId,
  resultRecordId,
  runId,
  attempt,
  tiktokMetadata,
  youtubeMetadata,
}: PublishToPlatformArgs): Promise<PlatformStepOutcome> {
  // ONE deadline for this step, stamped before anything else and shared by
  // every in-step retry: the platform work must end inside Vercel's 300s
  // per-invocation cap with time left to record the result (publishBudget.ts).
  const deadline = publishDeadline();
  const client = getPlatformClient(connectionRef.platform);

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
        errorCode: "CONNECTION_GONE",
        errorMessage: "This platform connection was removed. Reconnect and retry.",
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
    // resetting at midnight Pacific; youtubeQuota.ts). Spend ONE slot per attempt,
    // after the claim and the connection checks, so a result that never reaches
    // YouTube costs none, and OUTSIDE withTransientRetries below, so an in-step
    // retry never spends a second. With none left the API is not called: the
    // result waits for the reset (plus its grace), as a daily limit.
    if (connection.platform === "youtube") {
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
    logger.error(`[Inngest] Platform ${connectionRef.platform} failed to publish`, {
      platform: connectionRef.platform,
      resultRecordId,
      code: err.code,
      error: err,
    });
    await finalizeClaimedResult(resultRecordId, runId, {
      status: "failed",
      errorCode: err.code ?? "PUBLISH_FAILED",
      errorMessage: err.message || "Failed to publish to platform.",
    });
    return { platform: connectionRef.platform, status: "failed", error: err.message };
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

      const resultRecords = await prisma.postJobResult.findMany({
        where: { postJobId },
        select: { id: true, platform: true },
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
      await step.run("mark-failed-no-connections", async () => {
        await prisma.postJob.update({
          where: { id: postJobId },
          data: { status: "failed" },
        });
      });
      return { error: "No connections" };
    }

    // Team Workspaces (Task 6, controller-added scope): the footer is the
    // WORKSPACE's brand fields (companyWebsite/defaultHashtags — design §2),
    // never the acting user's — a member can publish/retry a teammate's
    // post, and the footer must stay deterministic regardless of who acts.
    const fullBaseCaption = buildCaptionWithFooter(baseCaption, setupData.workspace);
    const overrides = perPlatformOverrides as Partial<Record<Platform, string>> | null;

    logger.info(`[Inngest] Publishing to ${setupData.socialConnections.length} platforms`, {
      postJobId,
      count: setupData.socialConnections.length,
    });

    // Process each platform as a separate step (allows longer execution per
    // platform). The steps are planned here and run by runPlatformStepsWithDeferrals
    // (platformSteps.ts): every platform once, in this order, then each one a
    // platform rate-limited again after its wait (2026-11-01 scale audit, platform
    // limits), so a sleeping YouTube never delays LinkedIn.
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
        run: async (attempt) => {
          // Final review M2 + jobs H6: only the run that claims a still-`pending`
          // result publishes it — the route may already have failed it after an
          // ambiguous dispatch error, and a duplicate run may be ahead of us.
          const early = await claimOrSkip(resultRecord.id, runId, {
            step: "publish",
            postJobId,
            platform: connection.platform,
            attempt,
          });
          if (early) return early;

          return publishToPlatform({
            connectionRef: connection,
            mediaItem: setupData.mediaItem,
            caption,
            baseCaption,
            userId,
            resultRecordId: resultRecord.id,
            runId,
            attempt,
            tiktokMetadata,
            youtubeMetadata,
          });
        },
      });
    }

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
    try {
      await step.sendEvent("notify-outcome", {
        id: `notify-${postJobId}-${runId}`,
        name: "notification.requested",
        data: { userId, postJobId },
      });
    } catch (err) {
      logger.error("[Inngest] Failed to enqueue post-outcome notification (ignored)", { postJobId, error: err });
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
 * Roadmap Phase 1 — daily media retention sweep.
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
 * The candidate set is capped per run and drains over the daily cadence.
 */
export const mediaRetentionSweep = inngest.createFunction(
  { id: "media-retention-sweep", name: "Media Retention Sweep" },
  { cron: "0 3 * * *" },
  async ({ step }) => {
    const summary = await step.run("sweep-expired-media", async () => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

      // Coarse candidate filter (let the DB narrow the set): not already swept,
      // posted at least once, no non-terminal referencing job, and stale by age
      // (lastUsedAt when stamped, else createdAt). The authoritative rule and the
      // race-closing re-check run per item inside the transaction below.
      const candidates = await prisma.mediaItem.findMany({
        where: {
          deletedAt: null,
          postJobs: {
            some: {},
            none: { status: { notIn: [...TERMINAL_POST_JOB_STATUSES] } },
          },
          OR: [
            { lastUsedAt: { lt: cutoff } },
            { lastUsedAt: null, createdAt: { lt: cutoff } },
          ],
        },
        // Cap per run so a large first-deploy backlog (every pre-existing posted
        // item is a candidate once, blobs already gone) can't exceed the function
        // budget in one invocation; the daily cadence drains the rest.
        take: 500,
        select: { id: true },
      });

      let swept = 0;
      let skipped = 0;
      let errors = 0;

      for (const candidate of candidates) {
        try {
          const outcome = await prisma.$transaction(
            async (tx) => {
              // Lock the MediaItem row before re-checking, so a concurrent reuse
              // (which takes the same FOR UPDATE lock in createPostJobForExistingMedia)
              // serializes with us: after this returns we see any reuse that
              // committed first, and a reuse that arrives after waits until we
              // commit the soft-delete. Closes the check-then-act reuse race.
              await tx.$executeRaw`SELECT id FROM "MediaItem" WHERE id = ${candidate.id} FOR UPDATE`;

              const media = await tx.mediaItem.findUnique({
                where: { id: candidate.id },
                select: {
                  storageLocation: true,
                  deletedAt: true,
                  lastUsedAt: true,
                  createdAt: true,
                  _count: { select: { postJobs: true } },
                },
              });
              if (!media) return "skipped";

              // Fresh, in-transaction re-check of the race-sensitive predicate.
              const nonTerminalJobs = await tx.postJob.count({
                where: {
                  mediaItemId: candidate.id,
                  status: { notIn: [...TERMINAL_POST_JOB_STATUSES] },
                },
              });

              const eligible = isMediaSweepEligible({
                deletedAt: media.deletedAt,
                hasNonTerminalJob: nonTerminalJobs > 0,
                hasAnyJob: media._count.postJobs > 0,
                lastUsedAt: media.lastUsedAt,
                createdAt: media.createdAt,
                now,
                retentionDays: RETENTION_DAYS,
              });
              if (!eligible) return "skipped";

              // Mark the row first, then remove the blob: if `del` throws the
              // whole transaction rolls back, so we never record a delete we did
              // not actually perform. (`del` is idempotent for a missing blob.)
              // The blob is removed only when no OTHER live MediaItem (any
              // workspace) references the same URL — `POST /api/media` lets two
              // rows point at one file, and sweeping one must not destroy the
              // other's media (2026-11-01 audit, Task 8).
              await tx.mediaItem.update({
                where: { id: candidate.id },
                data: { deletedAt: now },
              });
              await deleteBlobUnlessShared(tx, {
                id: candidate.id,
                storageLocation: media.storageLocation,
              });
              return "swept";
            },
            { timeout: 15000 },
          );

          if (outcome === "swept") swept += 1;
          else skipped += 1;
        } catch (error) {
          errors += 1;
          logger.error("[Inngest] Failed to sweep media item", {
            mediaItemId: candidate.id,
            error,
          });
        }
      }

      console.log("[Inngest] Media retention sweep complete", {
        candidates: candidates.length,
        swept,
        skipped,
        errors,
      });
      return { candidates: candidates.length, swept, skipped, errors };
    });

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
        run: async (attempt): Promise<PlatformStepOutcome> => {
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
    // run whose platforms already published. Same run-scoped event id.
    try {
      await step.sendEvent("notify-outcome", {
        id: `notify-${postJobId}-${runId}`,
        name: "notification.requested",
        data: { userId, postJobId },
      });
    } catch (err) {
      logger.error("[Inngest] Failed to enqueue post-outcome notification (ignored)", { postJobId, error: err });
    }

    console.log("[Inngest] Retry job completed", { postJobId, ...finalResult });

    return { postJobId, status: finalResult.finalStatus, results };
  },
);

/**
 * Roadmap Phase 5 — cron due-scanner for scheduled posts (§6.2).
 *
 * Runs every minute. Atomically claims scheduled jobs whose `scheduledFor` has
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
 *    has `idempotency: event.data.postJobId`, so a second send triggers no run.
 *  - `notify-noconn-batch-<i>` is one `step.sendEvent` of the owner notifications
 *    for jobs that had no connection at run time (marked `failed` inside the
 *    chunk step, mirroring the existing no-connections path; reuses the same
 *    `notification.requested` → `sendNotification` →
 *    `deliverPostOutcomeNotification` path every other outcome uses, so the
 *    user's `notifyOnPostComplete` preference gates it identically). Each event
 *    has the id `notify-noconn-<postJobId>`.
 * That is at most 2 + 2 x 20 steps for a full tick of 1000.
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
  { cron: "* * * * *" },
  async ({ step }) => {
    const claimedIds = await step.run("claim-due-jobs", async () => {
      return claimDueScheduledJobs(new Date());
    });

    // Reconcile jobs stuck in_progress after a materialize/dispatch crash
    // (leaves no pending work and never reaches finalize).
    const reconciled = await step.run("reconcile-stuck-in-progress", async () => {
      return reconcileStuckInProgressJobs(new Date());
    });
    if (reconciled.reconciled > 0) {
      logger.info("[Inngest] Reconciled stuck in_progress jobs", reconciled);
    }

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
 * `retries: 1` gives a single retry for a transient failure (e.g. a blip
 * reaching the DB), but in practice this function cannot fail loudly at all:
 * all of its real work is delegated to `deliverPostOutcomeNotification`,
 * which is itself fully env-gated (no-ops with no DB access when
 * `RESEND_API_KEY` is unset) and never throws (every branch, including a
 * send failure, is caught and logged there). This function's job is only to
 * be the Inngest entry point + step-memoization boundary.
 */
export const sendNotification = inngest.createFunction(
  {
    id: "send-notification",
    name: "Send Post Outcome Notification",
    retries: 1,
  },
  { event: "notification.requested" },
  async ({ event, step }) => {
    // `event.data` is untyped (schemaless Inngest client) — assign into typed
    // locals here rather than annotating with `any` (mirrors retryPlatforms).
    const userId: string = event.data.userId;
    const postJobId: string = event.data.postJobId;

    // At-least-once (review Minor #2): if the email sends but Inngest loses the
    // step ack, `retries: 1` re-invokes this and the user gets a duplicate email
    // for one outcome. Accepted — best-effort delivery, at most two, no dedupe.
    await step.run("deliver-notification", async () => {
      await deliverPostOutcomeNotification({ userId, postJobId });
    });

    return { postJobId };
  },
);

/**
 * Roadmap Phase 8 — hourly YouTube post-metrics sync (analytics, §7.3).
 *
 * Best-effort, isolated per item, and STRICTLY read-only w.r.t. posting: this
 * cron only reads engagement counts and upserts `PostMetric` rows — it never
 * touches PostJob/PostJobResult status or re-publishes anything, so it cannot
 * affect posting.
 *
 * Cadence: hourly (`0 * * * *`). `videos.list?part=statistics` costs 1 YouTube
 * quota unit/call, so ≤100 calls/hour (≤2,400/day) sits far under the default
 * 10,000/day project quota. Each run refreshes the most-recent `take` posts
 * (see `selectYouTubeMetricEligibleResults`), which is enough for "current"
 * stats; draining a >100-post tail by metric staleness is a future extension.
 *
 * Structure mirrors `mediaRetentionSweep`: one memoized `step.run` wrapping a
 * per-item try/catch loop, so a single video's network/refresh/upsert failure
 * cannot sink the batch. The upsert is idempotent (keyed on
 * (platform, externalPostId)), so a whole-step retry re-updates rather than
 * duplicates. Tokens are refreshed via the shared Google helper (writes only
 * accessToken/expiry, never refreshToken); a gone / `needsReconnect` connection
 * is skipped, not hammered.
 *
 * v1 = YouTube ONLY. The selector is platform-scoped to `youtube` and the loop
 * assumes YouTube; the block below is the documented extension point for adding
 * a per-platform fetcher later.
 */
export const youtubePostMetricsSync = inngest.createFunction(
  { id: "youtube-post-metrics-sync", name: "YouTube Post Metrics Sync" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const summary = await step.run("sync-youtube-metrics", async () => {
      const eligible = await selectYouTubeMetricEligibleResults(METRICS_SYNC_BATCH);

      // Per-RUN cache: workspaceId -> resolved connection (or null when
      // unavailable). Dedupes the connection load + token refresh when a
      // workspace has several videos in the batch, and makes one workspace's
      // reconnect/refresh failure skip all its items fast without re-hitting
      // the DB or Google. Function-local, so it resets every run. Team
      // Workspaces (Task 5): keyed by workspaceId (the shared connection) —
      // NOT userId, since the eligible item's poster may not be who connected
      // the platform. `connectorUserId` (the connection's own `userId`, i.e.
      // whoever connected this YouTube account) is carried alongside the
      // token so it can be stamped onto the PostMetric row below.
      const connectionCache = new Map<
        string,
        { accessToken: string; connectorUserId: string } | null
      >();

      async function resolveConnection(
        workspaceId: string,
      ): Promise<{ accessToken: string; connectorUserId: string } | null> {
        const cached = connectionCache.get(workspaceId);
        if (cached !== undefined) {
          return cached;
        }

        let resolved: { accessToken: string; connectorUserId: string } | null = null;
        try {
          const connection = await prisma.socialConnection.findUnique({
            where: { workspaceId_platform: { workspaceId, platform: "youtube" } },
          });
          // Skip a gone (disconnected) or `needsReconnect`-flagged connection —
          // do NOT push a known-bad token through refresh.
          if (connection && !connection.needsReconnect) {
            let active = connection;
            if (active.expiresAt && active.expiresAt.getTime() < Date.now()) {
              // Shared Google refresh: writes ONLY accessToken/expiry, NEVER
              // refreshToken (see googleTokens.ts). May throw + mark
              // needsReconnect on invalid_grant — caught here so token stays null.
              active = await refreshGoogleToken(active);
            }
            if (active.accessToken) {
              resolved = { accessToken: active.accessToken, connectorUserId: active.userId };
            }
          }
        } catch (error) {
          logger.error("[Inngest] YouTube metrics: connection resolve failed (skipping workspace)", {
            workspaceId,
            error,
          });
          resolved = null;
        }

        connectionCache.set(workspaceId, resolved);
        return resolved;
      }

      let updated = 0;
      let skippedNoConnection = 0;
      let skippedNotFound = 0;
      let errors = 0;

      for (const item of eligible) {
        // Isolate every item: one video's failure (network, token, upsert) must
        // never sink the batch — mirrors scheduledPostScanner / mediaRetentionSweep.
        try {
          const connection = await resolveConnection(item.workspaceId);
          if (!connection) {
            skippedNoConnection += 1;
            continue;
          }

          const result = await fetchYouTubeVideoStatistics(item.externalPostId, connection.accessToken);
          if (!result.ok) {
            errors += 1;
            continue;
          }
          // 200 but the video is gone/inaccessible (empty items) OR present but
          // carrying no parseable statistics: do NOT overwrite a prior good
          // snapshot with all-null counts — leave the last-known metric intact
          // (review Minor #2/#5; `found` alone doesn't prove there's data).
          if (!result.found || !hasAnyStatistic(result.stats)) {
            skippedNotFound += 1;
            continue;
          }

          // NOTE (review Minor #1, deferred): views/likes/comments are stored as
          // 32-bit Int. A count exceeding 2,147,483,647 would fail the write (and
          // be caught below as an item error). Not reachable for this app's
          // audience; widen these columns to BigInt if it ever serves channels
          // with billions of views (also convert bigint→Number at the DTO).
          const now = new Date();
          await prisma.postMetric.upsert({
            where: {
              platform_externalPostId: {
                platform: "youtube",
                externalPostId: item.externalPostId,
              },
            },
            create: {
              // Team Workspaces (Task 5): stamped from the CONNECTION's
              // connector (whoever connected this YouTube account) rather
              // than the post's creator — see EligibleMetricResult.userId's
              // doc comment (metricsScanner.ts) for the "legacy compat"
              // rationale.
              userId: connection.connectorUserId,
              workspaceId: item.workspaceId,
              platform: "youtube",
              externalPostId: item.externalPostId,
              postJobResultId: item.resultId,
              views: result.stats.views,
              likes: result.stats.likes,
              comments: result.stats.comments,
              // videos.list statistics does not expose shareCount → null (never 0).
              shares: null,
              raw: result.raw as Prisma.InputJsonValue,
              fetchedAt: now,
            },
            update: {
              userId: connection.connectorUserId,
              postJobResultId: item.resultId,
              views: result.stats.views,
              likes: result.stats.likes,
              comments: result.stats.comments,
              shares: null,
              raw: result.raw as Prisma.InputJsonValue,
              fetchedAt: now,
            },
          });
          updated += 1;
        } catch (error) {
          errors += 1;
          logger.error("[Inngest] YouTube metrics: failed to sync item", {
            resultId: item.resultId,
            externalPostId: item.externalPostId,
            error,
          });
        }
      }

      // EXTENSION POINT (v1 = YouTube only). To add a platform: implement a
      // per-platform fetcher with the same best-effort contract as
      // `fetchYouTubeVideoStatistics`, widen the selector's platform filter, and
      // branch on `item.platform` here. X (paid API tiers), Google Business
      // Profile (no per-post insight API), and LinkedIn personal shares (expose
      // little) are intentionally out of scope for v1 (spec §7.3).

      console.log("[Inngest] YouTube metrics sync complete", {
        eligible: eligible.length,
        updated,
        skippedNoConnection,
        skippedNotFound,
        errors,
      });
      return { eligible: eligible.length, updated, skippedNoConnection, skippedNotFound, errors };
    });

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

    return summary;
  },
);

/**
 * Daily connection-health sweep (publish-reliability plan, Task 2).
 *
 * Proactively refreshes every healthy connection whose access token is
 * expired or expiring within 24h (isProactiveRefreshEligible). Two effects:
 * (1) provider refresh-tokens stay alive (Google revokes grants unused for
 * ~6 months — exactly how the prod GBP connection died on 2026-07-26), and
 * (2) a dead grant is discovered TODAY, flips `needsReconnect` (the platform
 * clients do that themselves via markConnectionNeedsReconnect before
 * throwing), and every workspace OWNER gets ONE reconnect email — instead of
 * the user discovering it when a scheduled post fails.
 *
 * Email exactly-once: eligibility requires `needsReconnect === false`, so a
 * connection that flips is skipped by every later sweep; a transient network
 * failure during refresh leaves the flag false, sends nothing, and is simply
 * retried tomorrow. Cron slot 04:45 UTC — cadence map: media-retention 03:00,
 * scheduled-scanner every minute, youtube-metrics hourly :00,
 * stale-post-sweep hourly :30.
 *
 * SEC: the step returns COUNTS only — never connection rows (tokens).
 */
export const connectionHealthSweep = inngest.createFunction(
  { id: "connection-health-sweep", name: "Connection Health Sweep" },
  { cron: "45 4 * * *" },
  async ({ step }) => {
    const summary = await step.run("refresh-expiring-connections", async () => {
      const now = new Date();
      const candidates = await prisma.socialConnection.findMany({
        where: { needsReconnect: false, expiresAt: { not: null } },
      });

      let attempted = 0;
      let refreshed = 0;
      let flagged = 0;
      let emailed = 0;

      for (const connection of candidates) {
        if (!isProactiveRefreshEligible(connection, now)) continue;
        const client = getPlatformClient(connection.platform);
        if (!client?.refreshToken) continue;

        attempted++;
        try {
          await client.refreshToken(connection);
          refreshed++;
        } catch {
          // Terminal failures already flipped needsReconnect inside the
          // client (markConnectionNeedsReconnect); transient ones did not.
          // Re-read the flag to distinguish — email ONLY on the flip.
          const after = await prisma.socialConnection.findUnique({
            where: { id: connection.id },
            select: { needsReconnect: true, workspaceId: true },
          });
          if (!after?.needsReconnect) continue;
          flagged++;

          const [workspace, owners] = await Promise.all([
            prisma.workspace.findUnique({
              where: { id: after.workspaceId },
              select: { name: true },
            }),
            prisma.workspaceMember.findMany({
              where: { workspaceId: after.workspaceId, role: "owner" },
              select: { user: { select: { email: true } } },
            }),
          ]);
          const email = buildReconnectEmail({
            platformLabel: platformLabel(connection.platform),
            workspaceName: workspace?.name ?? "your workspace",
            appBaseUrl: process.env.NEXTAUTH_URL || null,
          });
          for (const owner of owners) {
            // sendEmail never throws (fail-safe transport).
            await sendEmail({ to: owner.user.email, ...email });
            emailed++;
          }
        }
      }

      return { candidates: candidates.length, attempted, refreshed, flagged, emailed };
    });

    logger.info("[Inngest] Connection health sweep complete", summary);
    return summary;
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
];
