import type { Platform } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SavedFileInfo } from "@/server/storage";

export interface CreatePostJobOnlyParams {
  userId: string;
  media: SavedFileInfo;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
}

export interface PostJobCreated {
  postJobId: string;
  mediaItemId: string;
  resultIds: string[];
}

export async function createPostJobOnly(
  params: CreatePostJobOnlyParams,
): Promise<PostJobCreated> {
  const { userId, media, baseCaption, location, perPlatformOverrides } = params;

  const socialConnections = await prisma.socialConnection.findMany({
    where: { userId },
  });

  if (socialConnections.length === 0) {
    throw new Error("NO_CONNECTIONS");
  }

  const metadata: { location?: { description: string } } = {};
  if (location) {
    metadata.location = { description: location };
  }

  // Roadmap Phase 1: this MediaItem is attached to a PostJob below, so stamp
  // `lastUsedAt` now. This drives age-based retention (set at attach time, not
  // just at run time, so a scheduled reuse that runs weeks later isn't treated
  // as stale). Never-posted library uploads via `POST /api/media` create no
  // PostJob and correctly leave `lastUsedAt = null`.
  const now = new Date();

  const mediaItem = await prisma.mediaItem.create({
    data: {
      userId,
      storageLocation: media.storageLocation,
      originalFilename: media.originalFilename,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      baseCaption,
      lastUsedAt: now,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      perPlatformOverrides: perPlatformOverrides
        ? (perPlatformOverrides as unknown as Record<string, string>)
        : undefined,
    },
  });

  const postJob = await prisma.postJob.create({
    data: {
      userId,
      mediaItemId: mediaItem.id,
      status: "in_progress",
    },
  });

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

  return {
    postJobId: postJob.id,
    mediaItemId: mediaItem.id,
    resultIds: resultRecords.map(r => r.id),
  };
}
