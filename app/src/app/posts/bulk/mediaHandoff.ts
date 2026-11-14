import { parseMediaIdsParam, resolveMediaHandoff } from "@/lib/bulkMedia";
import { prisma } from "@/lib/db";
import { toMediaItemDto, type MediaItemDto } from "@/lib/mediaDto";

/**
 * The Media items named in /posts/bulk?media=, read for ONE workspace. A foreign
 * or unknown id is never found, so it is only counted as skipped.
 */
export async function loadMediaHandoff(
  workspaceId: string,
  raw: string | string[] | undefined,
): Promise<{ items: MediaItemDto[]; skipped: number }> {
  const ids = parseMediaIdsParam(raw);
  if (ids.length === 0) return { items: [], skipped: 0 };
  const rows = await prisma.mediaItem.findMany({
    where: { id: { in: ids }, workspaceId, deletedAt: null },
    select: {
      id: true,
      storageLocation: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      baseCaption: true,
      perPlatformOverrides: true,
      createdAt: true,
      lastUsedAt: true,
      metadata: true,
    },
  });
  return resolveMediaHandoff(ids, rows.map(toMediaItemDto));
}
