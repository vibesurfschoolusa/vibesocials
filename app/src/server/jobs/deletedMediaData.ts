import type { Prisma } from "@prisma/client";

/** A MediaItem as far as marking it deleted needs to see it. */
export interface DeletedMediaSource {
  originalFilename: string;
  metadata: Prisma.JsonValue | null;
}

// The values below are also written by the backfill migration
// 20261114500000_clear_deleted_client_media_data; clearDeletedClientMediaMigration.test.ts
// checks that the two agree. Change one, change both.

/** The client's own words on a file sent through an upload link (upload-link/[token]/media). */
export const CLIENT_METADATA_FIELDS = ["senderName", "note"] as const;

/** What a deleted client file is called: `deleted-file.<ext>`, or this alone. */
export const DELETED_FILE_BASENAME = "deleted-file";

/** The extension kept from the original name (the same text in JS and Postgres regex). */
export const DELETED_FILE_EXTENSION_PATTERN = "\\.([A-Za-z0-9]{1,10})$";
const EXTENSION = new RegExp(DELETED_FILE_EXTENSION_PATTERN);

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
    if ((CLIENT_METADATA_FIELDS as readonly string[]).includes(key) || value === undefined) continue;
    kept[key] = value;
  }
  const extension = EXTENSION.exec(item.originalFilename)?.[1]?.toLowerCase();
  return {
    deletedAt,
    originalFilename: extension ? `${DELETED_FILE_BASENAME}.${extension}` : DELETED_FILE_BASENAME,
    metadata: kept as Prisma.InputJsonObject,
  };
}
