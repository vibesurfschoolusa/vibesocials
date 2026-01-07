import { inngest } from "@/lib/inngest";
import { prisma } from "@/lib/db";
import { getPlatformClient } from "@/server/platforms";
import type { Platform, User } from "@prisma/client";

function buildCaptionWithFooter(baseCaption: string, user: User): string {
  const parts = [baseCaption.trim()];
  
  if (user.companyWebsite?.trim()) {
    parts.push(`For more info visit ${user.companyWebsite.trim()}`);
  }
  
  if (user.defaultHashtags?.trim()) {
    parts.push(user.defaultHashtags.trim());
  }
  
  return parts.join('\n\n');
}

export const publishToAllPlatforms = inngest.createFunction(
  { 
    id: "publish-to-all-platforms",
    name: "Publish to All Platforms",
    retries: 0,
  },
  { event: "post/publish.requested" },
  async ({ event, step }) => {
    const { postJobId, userId, mediaItemId, baseCaption, location, perPlatformOverrides } = event.data;

    console.log("[Inngest] Starting background publish job", { postJobId, mediaItemId });

    // Fetch all required data
    const [user, mediaItem, socialConnections, postJob] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.mediaItem.findUnique({ where: { id: mediaItemId } }),
      prisma.socialConnection.findMany({ where: { userId } }),
      prisma.postJob.findUnique({ where: { id: postJobId } }),
    ]);

    if (!user || !mediaItem || !postJob) {
      console.error("[Inngest] Missing required data", { user: !!user, mediaItem: !!mediaItem, postJob: !!postJob });
      return { error: "Missing required data" };
    }

    if (socialConnections.length === 0) {
      await prisma.postJob.update({
        where: { id: postJobId },
        data: { status: "failed" },
      });
      return { error: "No connections" };
    }

    const fullBaseCaption = buildCaptionWithFooter(baseCaption, user);
    const overrides = perPlatformOverrides as Partial<Record<Platform, string>> | null;

    // Get existing result records
    const resultRecords = await prisma.postJobResult.findMany({
      where: { postJobId },
    });

    console.log(`[Inngest] Publishing to ${socialConnections.length} platforms`);

    // Process each platform - Inngest handles the timeout
    const results = await Promise.all(
      socialConnections.map(async (connection) => {
        const resultRecord = resultRecords.find(r => r.platform === connection.platform);
        if (!resultRecord) {
          console.error(`[Inngest] No result record for ${connection.platform}`);
          return null;
        }

        const captionOverride = overrides?.[connection.platform] ?? null;
        const caption = captionOverride 
          ? buildCaptionWithFooter(captionOverride, user)
          : fullBaseCaption;

        const client = getPlatformClient(connection.platform);

        if (!client) {
          return await prisma.postJobResult.update({
            where: { id: resultRecord.id },
            data: {
              status: "failed",
              errorCode: "CLIENT_NOT_FOUND",
              errorMessage: "No client configured for this platform.",
            },
          });
        }

        try {
          console.log(`[Inngest] Publishing to ${connection.platform}...`);
          const publishResult = await client.publishVideo({
            user: { id: userId } as any,
            socialConnection: connection,
            mediaItem,
            caption,
          });

          console.log(`[Inngest] ${connection.platform} success`, { externalPostId: publishResult.externalPostId });
          return await prisma.postJobResult.update({
            where: { id: resultRecord.id },
            data: {
              status: "success",
              externalPostId: publishResult.externalPostId ?? null,
            },
          });
        } catch (error: any) {
          console.error(`[Inngest] Platform ${connection.platform} failed:`, error.message);
          return await prisma.postJobResult.update({
            where: { id: resultRecord.id },
            data: {
              status: "failed",
              errorCode: error?.code ?? "PUBLISH_FAILED",
              errorMessage: error?.message || "Failed to publish to platform.",
            },
          });
        }
      })
    );

    const validResults = results.filter(Boolean);
    const hasSuccess = validResults.some((r) => r?.status === "success");

    const finalStatus = hasSuccess ? "completed" : "failed";

    await prisma.postJob.update({
      where: { id: postJobId },
      data: { status: finalStatus },
    });

    // Clean up blob storage if completed
    if (finalStatus === "completed") {
      try {
        const { del } = await import("@vercel/blob");
        await del(mediaItem.storageLocation);
        console.log("[Inngest] Deleted media from blob storage", { mediaItemId });
      } catch (error) {
        console.error("[Inngest] Failed to delete media from blob storage", error);
      }
    }

    console.log("[Inngest] Job completed", { postJobId, finalStatus, successCount: validResults.filter(r => r?.status === "success").length });

    return { 
      postJobId, 
      status: finalStatus,
      results: validResults.map(r => ({ platform: r?.platform, status: r?.status })),
    };
  }
);

export const inngestFunctions = [publishToAllPlatforms];
