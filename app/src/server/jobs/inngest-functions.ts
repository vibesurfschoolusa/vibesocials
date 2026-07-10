import { del } from "@vercel/blob";

import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { getPlatformClient } from "@/server/platforms";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import {
  RETENTION_DAYS,
  TERMINAL_POST_JOB_STATUSES,
  isMediaSweepEligible,
} from "@/server/jobs/mediaRetention";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";
import { claimDueScheduledJobs } from "@/server/jobs/scheduledScanner";
import { prepareDeferredPostJobDispatch } from "@/server/jobs/posting";
import { deliverPostOutcomeNotification } from "@/server/notifications/postOutcomeEmail";
import type { MediaItem, Platform, SocialConnection, User } from "@prisma/client";
import type {
  PublishContext,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";

// Simplified types for serialized data from step.run()
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
}

interface SerializedConnection {
  id: string;
  createdAt: string;
  updatedAt: string;
  platform: Platform;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  accountIdentifier: string;
  scopes: unknown;
  metadata: unknown;
  userId: string;
}

// Helper to publish to a single platform
async function publishToPlatform(
  connection: SerializedConnection,
  mediaItem: SerializedMediaItem,
  caption: string,
  userId: string,
  resultRecordId: string,
  tiktokMetadata?: TikTokPostMetadata,
  youtubeMetadata?: YouTubePostMetadata
): Promise<{ platform: Platform; status: string; error?: string }> {
  const client = getPlatformClient(connection.platform);

  if (!client) {
    await prisma.postJobResult.update({
      where: { id: resultRecordId },
      data: {
        status: "failed",
        errorCode: "CLIENT_NOT_FOUND",
        errorMessage: "No client configured for this platform.",
      },
    });
    return { platform: connection.platform, status: "failed", error: "No client" };
  }

  try {
    console.log(`[Inngest] Publishing to ${connection.platform}...`);
    // step.run() serializes Dates to strings, so these records don't structurally
    // match the Prisma types PublishContext expects. The platform clients only read
    // fields present on both the serialized and Prisma shapes (and nothing reads
    // `user` beyond `id`), so assert through `unknown` at this boundary.
    const publishContext: PublishContext = {
      user: { id: userId } as unknown as User,
      socialConnection: connection as unknown as SocialConnection,
      mediaItem: mediaItem as unknown as MediaItem,
      caption,
    };

    // Add TikTok metadata if publishing to TikTok
    if (connection.platform === "tiktok" && tiktokMetadata) {
      publishContext.tiktokMetadata = tiktokMetadata;
    }

    // Add YouTube metadata if publishing to YouTube
    if (connection.platform === "youtube" && youtubeMetadata) {
      publishContext.youtubeMetadata = youtubeMetadata;
    }

    const publishResult = await client.publishVideo(publishContext);

    console.log(`[Inngest] ${connection.platform} success`, { externalPostId: publishResult.externalPostId });
    await prisma.postJobResult.update({
      where: { id: resultRecordId },
      data: {
        status: "success",
        externalPostId: publishResult.externalPostId ?? null,
      },
    });
    return { platform: connection.platform, status: "success" };
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    console.error(`[Inngest] Platform ${connection.platform} failed:`, err.message);
    await prisma.postJobResult.update({
      where: { id: resultRecordId },
      data: {
        status: "failed",
        errorCode: err.code ?? "PUBLISH_FAILED",
        errorMessage: err.message || "Failed to publish to platform.",
      },
    });
    return { platform: connection.platform, status: "failed", error: err.message };
  }
}

export const publishToAllPlatforms = inngest.createFunction(
  { 
    id: "publish-to-all-platforms",
    name: "Publish to All Platforms",
    retries: 0,
  },
  { event: "post/publish.requested" },
  async ({ event, step }) => {
    const { postJobId, userId, mediaItemId, baseCaption, perPlatformOverrides, tiktokMetadata, youtubeMetadata } = event.data;

    console.log("[Inngest] Starting background publish job", { postJobId, mediaItemId });

    // Step 1: Fetch all required data
    const setupData = await step.run("fetch-data", async () => {
      const [user, mediaItem, socialConnections, postJob] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.mediaItem.findUnique({ where: { id: mediaItemId } }),
        prisma.socialConnection.findMany({ where: { userId } }),
        prisma.postJob.findUnique({ where: { id: postJobId } }),
      ]);

      if (!user || !mediaItem || !postJob) {
        throw new Error("Missing required data");
      }

      const resultRecords = await prisma.postJobResult.findMany({
        where: { postJobId },
      });

      return {
        user,
        mediaItem,
        socialConnections,
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

    const fullBaseCaption = buildCaptionWithFooter(baseCaption, setupData.user);
    const overrides = perPlatformOverrides as Partial<Record<Platform, string>> | null;

    console.log(`[Inngest] Publishing to ${setupData.socialConnections.length} platforms`);

    // Process each platform as a separate step (allows longer execution per platform)
    const results: { platform: Platform; status: string; error?: string }[] = [];

    for (const connection of setupData.socialConnections) {
      const resultRecord = setupData.resultRecords.find(r => r.platform === connection.platform);
      if (!resultRecord) {
        console.error(`[Inngest] No result record for ${connection.platform}`);
        continue;
      }

      const captionOverride = overrides?.[connection.platform] ?? null;
      const caption = captionOverride 
        ? buildCaptionWithFooter(captionOverride, setupData.user)
        : fullBaseCaption;

      // Each platform upload is a separate step - this allows checkpointing
      const result = await step.run(`publish-to-${connection.platform}`, async () => {
        return publishToPlatform(
          connection,
          setupData.mediaItem,
          caption,
          userId,
          resultRecord.id,
          tiktokMetadata,
          youtubeMetadata
        );
      });

      results.push(result);
    }

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
      // had run (the case the retry path relies on).
      const dbResults = await prisma.postJobResult.findMany({
        where: { postJobId },
        select: { status: true },
      });
      const finalStatus = recomputePostJobStatus(dbResults);

      await prisma.postJob.update({
        where: { id: postJobId },
        data: { status: finalStatus },
      });

      return {
        finalStatus,
        successCount: dbResults.filter((r) => r.status === "success").length,
      };
    });

    // Roadmap Phase 6 (spec §7.2): fire-and-forget the best-effort post-outcome
    // email. `step.sendEvent` is memoized (exactly-once per finalize) and only
    // enqueues `notification.requested` — it does NOT await `sendNotification`,
    // let alone email delivery, so this can never delay or fail this job.
    await step.sendEvent("notify-outcome", {
      name: "notification.requested",
      data: { userId, postJobId },
    });

    console.log("[Inngest] Job completed", { postJobId, ...finalResult });

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
 * the blob (`del`), and soft-deletes the row (`deletedAt = now`, the row itself
 * is kept for history/captions). Never-posted library uploads are exempt — see
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
              await tx.mediaItem.update({
                where: { id: candidate.id },
                data: { deletedAt: now },
              });
              await del(media.storageLocation);
              return "swept";
            },
            { timeout: 15000 },
          );

          if (outcome === "swept") swept += 1;
          else skipped += 1;
        } catch (error) {
          errors += 1;
          console.error("[Inngest] Failed to sweep media item", {
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
 * IDEMPOTENCY (defense-in-depth): the `concurrency` key below serializes runs
 * per `postJobId`, so two overlapping retry events for the same job can never
 * re-run the same platform at the same time. The endpoint's conditional claim
 * is the primary guard; this is the second layer.
 *
 * Caption source: unlike the initial publish (which carries caption/overrides
 * in the event payload), a retry re-derives them from the persisted
 * `MediaItem.baseCaption` / `perPlatformOverrides`. Per-post TikTok/YouTube
 * metadata (e.g. YouTube privacy) is NOT persisted per job, so a retry falls
 * back to each client's SAFE default (YouTube `unlisted`, TikTok `SELF_ONLY`).
 */
export const retryPlatforms = inngest.createFunction(
  {
    id: "retry-platforms",
    name: "Retry Failed Platforms",
    retries: 0,
    // Serialize by PostJob: overlapping retries for the same job queue behind
    // one another instead of double-running a platform (posting isn't
    // idempotent). Pairs with the endpoint's failed->pending conditional claim.
    concurrency: {
      limit: 1,
      key: "event.data.postJobId",
    },
  },
  { event: "post/retry.requested" },
  async ({ event, step }) => {
    // `event.data` is untyped (schemaless Inngest client) — assign into typed
    // locals here rather than annotating with `any`.
    const postJobId: string = event.data.postJobId;
    const userId: string = event.data.userId;
    const platforms: Platform[] = event.data.platforms ?? [];

    console.log("[Inngest] Starting retry job", { postJobId, platforms });

    if (platforms.length === 0) {
      return { postJobId, error: "No platforms to retry" };
    }

    // Fetch everything needed for just the named platforms, scoped to the owner.
    const setupData = await step.run("fetch-retry-data", async () => {
      const postJob = await prisma.postJob.findFirst({
        where: { id: postJobId, userId },
      });
      if (!postJob) {
        return null;
      }

      const [user, mediaItem, connections, resultRecords] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.mediaItem.findUnique({ where: { id: postJob.mediaItemId } }),
        prisma.socialConnection.findMany({
          where: { userId, platform: { in: platforms } },
        }),
        prisma.postJobResult.findMany({
          where: { postJobId, platform: { in: platforms } },
        }),
      ]);

      return { user, mediaItem, connections, resultRecords };
    });

    if (!setupData) {
      console.error("[Inngest] Retry job not found or not owned", { postJobId });
      return { postJobId, error: "Job not found" };
    }

    const { user, mediaItem, connections, resultRecords } = setupData;

    // The blob must still exist to re-publish. The endpoint already gates this,
    // but a concurrent retention sweep could have removed it in between — fail
    // the re-queued results deterministically so the job never hangs
    // `in_progress`, then recompute.
    if (!user || !mediaItem || mediaItem.deletedAt !== null) {
      await step.run("fail-media-unavailable", async () => {
        await prisma.postJobResult.updateMany({
          where: { postJobId, platform: { in: platforms }, status: "pending" },
          data: {
            status: "failed",
            errorCode: "MEDIA_UNAVAILABLE",
            errorMessage:
              "The media for this post is no longer available. Recreate the post.",
          },
        });
        const dbResults = await prisma.postJobResult.findMany({
          where: { postJobId },
          select: { status: true },
        });
        await prisma.postJob.update({
          where: { id: postJobId },
          data: { status: recomputePostJobStatus(dbResults) },
        });
      });
      return { postJobId, error: "Media unavailable" };
    }

    const fullBaseCaption = buildCaptionWithFooter(mediaItem.baseCaption, user);
    const overrides = mediaItem.perPlatformOverrides as
      | Partial<Record<Platform, string>>
      | null;

    const results: { platform: Platform; status: string; error?: string }[] = [];

    for (const platform of platforms) {
      const resultRecord = resultRecords.find((r) => r.platform === platform);
      if (!resultRecord) {
        // No re-queued result row for this platform — nothing to retry.
        console.error("[Inngest] No result record to retry", { postJobId, platform });
        continue;
      }

      const connection = connections.find((c) => c.platform === platform);

      const result = await step.run(`retry-${platform}`, async () => {
        if (!connection) {
          // The platform was disconnected since the original post; there is no
          // token to publish with. Fail with a reconnect-shaped code so the UI
          // can point the user at Settings.
          await prisma.postJobResult.update({
            where: { id: resultRecord.id },
            data: {
              status: "failed",
              errorCode: "RECONNECT_REQUIRED",
              errorMessage:
                "This platform is no longer connected. Reconnect it in Settings and try again.",
            },
          });
          return { platform, status: "failed", error: "No connection" };
        }

        const captionOverride = overrides?.[platform] ?? null;
        const caption = captionOverride
          ? buildCaptionWithFooter(captionOverride, user)
          : fullBaseCaption;

        // Per-post TikTok/YouTube metadata isn't persisted, so a retry can't
        // recover the user's original privacy choice. Use each platform's SAFEST
        // value so a retry is never MORE public than the user picked: TikTok ->
        // its SELF_ONLY default (arg omitted), YouTube -> explicit "private"
        // (the client's own default "unlisted" is MORE public than a user's
        // "private", which would be a silent privacy escalation).
        return publishToPlatform(
          connection,
          mediaItem,
          caption,
          userId,
          resultRecord.id,
          undefined,
          platform === "youtube" ? { privacyStatus: "private" } : undefined,
        );
      });

      results.push(result);
    }

    // Recompute PostJob.status from ALL results (the retried platforms plus the
    // ones that already succeeded and were never touched) via the shared rule.
    const finalResult = await step.run("finalize-retry", async () => {
      const dbResults = await prisma.postJobResult.findMany({
        where: { postJobId },
        select: { status: true },
      });
      const finalStatus = recomputePostJobStatus(dbResults);

      await prisma.postJob.update({
        where: { id: postJobId },
        data: { status: finalStatus },
      });

      return {
        finalStatus,
        successCount: dbResults.filter((r) => r.status === "success").length,
      };
    });

    // Roadmap Phase 6 (spec §7.2): same fire-and-forget hook as the initial
    // publish path above — a retry reaching a terminal state is itself a new
    // outcome worth emailing (e.g. the user just found out their retry of a
    // failed platform succeeded, or failed again).
    await step.sendEvent("notify-outcome", {
      name: "notification.requested",
      data: { userId, postJobId },
    });

    console.log("[Inngest] Retry job completed", { postJobId, ...finalResult });

    return { postJobId, status: finalResult.finalStatus, results };
  },
);

/**
 * Roadmap Phase 5 — cron due-scanner for scheduled posts (§6.2).
 *
 * Runs every minute. Atomically claims scheduled jobs whose `scheduledFor` has
 * arrived (`claimDueScheduledJobs`, scheduled → in_progress), then for each
 * claimed job materializes its per-platform results from the connections that
 * exist NOW (`prepareDeferredPostJobDispatch` — the review's run-time-result
 * fix, §6.3) and hands off to the SAME `post/publish.requested` /
 * `publishToAllPlatforms` path immediate posts use (which is untouched and
 * stays short-lived / freely deployable — no long `sleepUntil` inside it).
 *
 * Step structure gives exactly-once dispatch under Inngest step-memoization:
 *  - `claim-due-jobs` is memoized, so a function retry never re-claims.
 *  - each `materialize-{id}` is memoized + idempotent (creates results only if
 *    none exist yet), so a retry never duplicates result rows or the live post.
 *  - `step.sendEvent` is a memoized step, so a completed send is never re-sent.
 * A job with no connections at run time is marked `failed` inside the
 * materialize step (mirrors the existing no-connections path).
 */
export const scheduledPostScanner = inngest.createFunction(
  { id: "scheduled-post-scanner", name: "Scheduled Post Scanner" },
  { cron: "* * * * *" },
  async ({ step }) => {
    const claimedIds = await step.run("claim-due-jobs", async () => {
      return claimDueScheduledJobs(new Date());
    });

    let dispatched = 0;
    let failedNoConnections = 0;
    let dispatchErrors = 0;

    for (const postJobId of claimedIds) {
      // Isolate each claimed job (review Minor #1): a materialize/dispatch that
      // throws even after Inngest exhausts the step's retries must not abort the
      // whole scan and strand every LATER job in the batch (already flipped to
      // in_progress, so the next tick — which only re-queries `scheduled` — never
      // re-claims them). Catching the terminal step error here bounds the blast
      // radius to the single failing job and lets the rest dispatch. Successful
      // steps remain memoized, so transient errors still get the normal retries.
      try {
        const prep = await step.run(`materialize-${postJobId}`, async () => {
          return prepareDeferredPostJobDispatch(postJobId);
        });

        if (prep.ok) {
          await step.sendEvent(`publish-${postJobId}`, {
            name: "post/publish.requested",
            data: prep.event,
          });
          dispatched += 1;
        } else if (prep.reason === "NO_CONNECTIONS") {
          failedNoConnections += 1;
        }
      } catch (error) {
        // The job stays in_progress (a rare, no-known-trigger case); surfaced
        // loudly for reconciliation rather than silently marked failed, which
        // would mislabel a transient DB blip.
        console.error(`[Inngest] Scheduled dispatch failed for ${postJobId}`, error);
        dispatchErrors += 1;
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

    await step.run("deliver-notification", async () => {
      await deliverPostOutcomeNotification({ userId, postJobId });
    });

    return { postJobId };
  },
);

export const inngestFunctions = [
  publishToAllPlatforms,
  mediaRetentionSweep,
  retryPlatforms,
  scheduledPostScanner,
  sendNotification,
];
