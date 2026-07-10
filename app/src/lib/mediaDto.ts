import type { MediaItem } from "@prisma/client";

/**
 * Display-only projection of a `MediaItem` for `GET /api/media` and the media
 * library UI (Roadmap Phase 1; reused by the delete/reuse phases).
 *
 * Follows the repo's DTO discipline: it DROPS `userId` and internal lifecycle
 * columns (`metadata`, `deletedAt`, `lastUsedAt`) that the client never needs.
 * It intentionally KEEPS `storageLocation` because the library renders
 * thumbnails directly from that blob URL — and Vercel blobs are `access:"public"`,
 * so this URL is already publicly reachable and exposes no secret.
 */
export interface MediaItemDto {
  id: string;
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  perPlatformOverrides: MediaItem["perPlatformOverrides"];
  /** ISO-8601 string (Prisma `Date` serialized for the wire). */
  createdAt: string;
}

/**
 * The subset of `MediaItem` fields required to build a {@link MediaItemDto}.
 * Declared as a structural `Pick` so both a full row and a narrow Prisma
 * `select` of exactly these columns satisfy it.
 */
export type MediaItemDtoSource = Pick<
  MediaItem,
  | "id"
  | "storageLocation"
  | "originalFilename"
  | "mimeType"
  | "sizeBytes"
  | "baseCaption"
  | "perPlatformOverrides"
  | "createdAt"
>;

/** Map a MediaItem (or a select-narrowed subset) to its display DTO. */
export function toMediaItemDto(item: MediaItemDtoSource): MediaItemDto {
  return {
    id: item.id,
    storageLocation: item.storageLocation,
    originalFilename: item.originalFilename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    baseCaption: item.baseCaption,
    perPlatformOverrides: item.perPlatformOverrides,
    createdAt: item.createdAt.toISOString(),
  };
}
