import type { MediaItem, Platform, PostJob, PostJobResult, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getPlatformClient } from "@/server/platforms";
import type { SavedFileInfo } from "@/server/storage";

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

export interface CreatePostJobParams {
  userId: string;
  media: SavedFileInfo;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}

export interface CreatePostJobFromExistingMediaParams {
  userId: string;
  mediaItemId: string;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}

export interface PostJobWithResults {
  postJob: PostJob;
  results: PostJobResult[];
}

async function runPostJobForMediaItem(params: {
  userId: string;
  mediaItem: MediaItem;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}): Promise<PostJobWithResults> {
  const { userId, mediaItem, baseCaption, location, perPlatformOverrides } = params;

  // Fetch user to get caption footer settings
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const socialConnections = await prisma.socialConnection.findMany({
    where: { userId },
  });

  if (socialConnections.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }

  // Build caption with company website and hashtags footer
  const fullBaseCaption = buildCaptionWithFooter(baseCaption, user);

  const postJob = await prisma.postJob.create({
    data: {
      userId,
      mediaItemId: mediaItem.id,
      status: "pending",
    },
  });

  let overrides: Partial<Record<Platform, string>> | null = null;
  if (perPlatformOverrides && Object.keys(perPlatformOverrides).length > 0) {
    overrides = perPlatformOverrides;
  } else if (mediaItem.perPlatformOverrides) {
    overrides = mediaItem.perPlatformOverrides as unknown as Partial<
      Record<Platform, string>
    >;
  }

  // Create result records for all platforms first
  const resultRecords = await Promise.all(
    socialConnections.map(connection =>
      prisma.postJobResult.create({
        data: {
          postJobId: postJob.id,
          platform: connection.platform,
          socialConnectionId: connection.id,
          status: "pending",
        },
      })
    )
  );

  console.log(`[PostJob] Publishing to ${socialConnections.length} platforms in parallel`);

  // Run all platform uploads in parallel to avoid timeouts
  const results = await Promise.all(
    socialConnections.map(async (connection, index) => {
      const resultRecord = resultRecords[index];
      
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
        const publishResult = await client.publishVideo({
          user: { id: userId } as any,
          socialConnection: connection,
          mediaItem,
          caption,
        });

        return await prisma.postJobResult.update({
          where: { id: resultRecord.id },
          data: {
            status: "success",
            externalPostId: publishResult.externalPostId ?? null,
          },
        });
      } catch (error: any) {
        console.error(`[PostJob] Platform ${connection.platform} failed:`, error);
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

  const hasSuccess = results.some((r) => r.status === "success");
  const hasPending = results.some((r) => r.status === "pending");

  const finalStatus: PostJob["status"] = hasPending
    ? "in_progress"
    : hasSuccess
    ? "completed"
    : "failed";

  const updatedJob = await prisma.postJob.update({
    where: { id: postJob.id },
    data: { status: finalStatus },
  });

  if (finalStatus === "completed") {
    try {
      const { del } = await import("@vercel/blob");
      await del(mediaItem.storageLocation);
      console.log("[PostJob] Deleted media from blob storage", {
        mediaItemId: mediaItem.id,
        storageLocation: mediaItem.storageLocation,
      });
    } catch (error) {
      console.error("[PostJob] Failed to delete media from blob storage", {
        mediaItemId: mediaItem.id,
        error,
      });
      // Don't fail the job if cleanup fails
    }
  }

  return {
    postJob: updatedJob,
    results,
  };
}

export async function createAndRunPostJob(
  params: CreatePostJobParams,
): Promise<PostJobWithResults> {
  const { userId, media, baseCaption, location, perPlatformOverrides } = params;

  const metadata: any = {};
  if (location) {
    metadata.location = { description: location };
  }

  const mediaItem = await prisma.mediaItem.create({
    data: {
      userId,
      storageLocation: media.storageLocation,
      originalFilename: media.originalFilename,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      baseCaption,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      perPlatformOverrides: perPlatformOverrides
        ? (perPlatformOverrides as unknown as Record<string, string>)
        : undefined,
    },
  });

  return runPostJobForMediaItem({
    userId,
    mediaItem,
    baseCaption,
    location,
    perPlatformOverrides,
  });
}

export async function createAndRunPostJobForExistingMedia(
  params: CreatePostJobFromExistingMediaParams,
): Promise<PostJobWithResults> {
  const { userId, mediaItemId, baseCaption, location, perPlatformOverrides } = params;

  let mediaItem = await prisma.mediaItem.findFirst({
    where: {
      id: mediaItemId,
      userId,
    },
  });

  if (!mediaItem) {
    throw new Error("MEDIA_ITEM_NOT_FOUND");
  }

  // Update location if provided
  if (location) {
    const existingMetadata = (mediaItem.metadata as any) || {};
    mediaItem = await prisma.mediaItem.update({
      where: { id: mediaItemId },
      data: {
        metadata: {
          ...existingMetadata,
          location: { description: location },
        },
      },
    });
  }

  return runPostJobForMediaItem({
    userId,
    mediaItem,
    baseCaption,
    location,
    perPlatformOverrides,
  });
}
