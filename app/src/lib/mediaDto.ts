import type { MediaItem } from "@prisma/client";

/**
 * Display-only projection of a `MediaItem` for `GET /api/media` and the media
 * library UI (Roadmap Phase 1; reused by the delete/reuse phases).
 *
 * Follows the repo's DTO discipline: it DROPS `userId` and internal lifecycle
 * columns (`metadata`, `deletedAt`) that the client never needs. It
 * intentionally KEEPS `storageLocation` because the library renders
 * thumbnails directly from that blob URL — and Vercel blobs are `access:"public"`,
 * so this URL is already publicly reachable and exposes no secret. It also
 * KEEPS `lastUsedAt` (as an ISO string) so the library can surface the
 * retention countdown via {@link daysUntilRemoval} below — display-only
 * timing data, not a secret.
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
  /**
   * ISO-8601 string of the last time this item was attached to a post, or
   * null when it has never been posted. See {@link daysUntilRemoval}.
   */
  lastUsedAt: string | null;
}

/**
 * The subset of `MediaItem` fields required to build a {@link MediaItemDto}.
 * Declared as a structural `Pick` so both a full row and a narrow Prisma
 * `select` of exactly these columns satisfy it. `lastUsedAt` is OPTIONAL
 * (rather than a plain `Pick` inclusion) so a caller whose `select` doesn't
 * request it — e.g. `GET /api/media/[id]`, which has no retention display —
 * still satisfies this type; `toMediaItemDto` treats a missing value the
 * same as an explicit `null`.
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
> & {
  lastUsedAt?: MediaItem["lastUsedAt"];
};

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
    lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Days until the retention sweep may remove a POSTED item's blob, or null when
 * the item has never been used in a post (never-posted uploads are exempt —
 * see server/jobs/mediaRetention.ts). 0 means "eligible now".
 */
export function daysUntilRemoval(
  lastUsedAt: string | null,
  retentionDays: number,
  now: Date,
): number | null {
  if (!lastUsedAt) return null;
  const last = new Date(lastUsedAt).getTime();
  if (Number.isNaN(last)) return null;
  const msLeft = last + retentionDays * 24 * 60 * 60 * 1000 - now.getTime();
  return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
}
