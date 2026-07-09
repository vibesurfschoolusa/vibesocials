import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { getPlatformClient } from "@/server/platforms";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import type { Platform } from "@prisma/client";
import type { YouTubePostMetadata } from "@/server/platforms/types";

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

interface SerializedResultRecord {
  id: string;
  platform: Platform;
}

// Helper to publish to a single platform
async function publishToPlatform(
  connection: SerializedConnection,
  mediaItem: SerializedMediaItem,
  caption: string,
  userId: string,
  resultRecordId: string,
  tiktokMetadata?: any,
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
    // Cast to any - serialized data from step.run() has string dates but works at runtime
    const publishContext: any = {
      user: { id: userId } as any,
      socialConnection: connection as any,
      mediaItem: mediaItem as any,
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
  } catch (error: any) {
    console.error(`[Inngest] Platform ${connection.platform} failed:`, error.message);
    await prisma.postJobResult.update({
      where: { id: resultRecordId },
      data: {
        status: "failed",
        errorCode: error?.code ?? "PUBLISH_FAILED",
        errorMessage: error?.message || "Failed to publish to platform.",
      },
    });
    return { platform: connection.platform, status: "failed", error: error.message };
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

    // Final step: Update job status and cleanup
    const finalResult = await step.run("finalize-job", async () => {
      const hasSuccess = results.some((r) => r.status === "success");
      const finalStatus = hasSuccess ? "completed" : "failed";

      await prisma.postJob.update({
        where: { id: postJobId },
        data: { status: finalStatus },
      });

      // Clean up blob storage after job completes (success or failure)
      // This prevents storage quota issues from failed posts
      try {
        const { del } = await import("@vercel/blob");
        await del(setupData.mediaItem.storageLocation);
        console.log("[Inngest] Deleted media from blob storage", { 
          mediaItemId, 
          finalStatus,
          note: "Blob deleted regardless of post status to free storage"
        });
      } catch (error) {
        console.error("[Inngest] Failed to delete media from blob storage", error);
      }

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

export const inngestFunctions = [publishToAllPlatforms];
