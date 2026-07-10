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
      const hasSuccess = results.some((r) => r.status === "success");
      const finalStatus = hasSuccess ? "completed" : "failed";

      await prisma.postJob.update({
        where: { id: postJobId },
        data: { status: finalStatus },
      });

      return { finalStatus, successCount: results.filter(r => r.status === "success").length };
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

export const inngestFunctions = [publishToAllPlatforms, mediaRetentionSweep];
