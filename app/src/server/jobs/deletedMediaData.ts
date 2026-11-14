import type { Prisma } from "@prisma/client";

/** A MediaItem as far as marking it deleted needs to see it. */
export interface DeletedMediaSource {
  originalFilename: string;
  metadata: Prisma.JsonValue | null;
}

/** The client's own words on a file sent through an upload link (upload-link/[token]/media). */
const CLIENT_FIELDS = ["senderName", "note"] as const;

/**
 * The update that marks a MediaItem deleted (Media delete, retention sweep).
 * The privacy page promises a client's name and note go with the file they
 * sent (G4, R2-pages M1), so for an upload link file it also drops those and
 * replaces the file's original name, which a client may have written their own
 * details into. The extension stays so the row still reads as a photo or video;
 * `source` and `linkId` stay so the row still counts as that link's file. Any
 * other file is only marked deleted.
 */
export function deletedMediaData(
  item: DeletedMediaSource,
  deletedAt: Date,
): { deletedAt: Date; originalFilename?: string; metadata?: Prisma.InputJsonObject } {
  const metadata = item.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return { deletedAt };
  if (metadata.source !== "upload_link") return { deletedAt };

  const kept: Record<string, Prisma.JsonValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((CLIENT_FIELDS as readonly string[]).includes(key) || value === undefined) continue;
    kept[key] = value;
  }
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(item.originalFilename)?.[1]?.toLowerCase();
  return {
    deletedAt,
    originalFilename: extension ? `deleted-file.${extension}` : "deleted-file",
    metadata: kept as Prisma.InputJsonObject,
  };
}
