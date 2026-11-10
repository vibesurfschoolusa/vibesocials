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
  /**
   * Client upload link (2026-11-10): present only on a file sent through a
   * workspace's upload link. The sender's name, or null when none was given (the
   * card then says "your client"). Only this and {@link clientNote} are read
   * from `metadata`; the rest of it never leaves the server.
   */
  clientSenderName?: string | null;
  /** The note sent with a client upload link file, or null; present only on such a file. */
  clientNote?: string | null;
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
  /** Optional like lastUsedAt: a caller that does not select it gets no client fields. */
  metadata?: MediaItem["metadata"];
};

/** The sender's name and note of a client upload link file, or null for any other file. */
function clientUploadFields(
  metadata: MediaItem["metadata"] | undefined,
): { clientSenderName: string | null; clientNote: string | null } | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (record.source !== "upload_link") return null;
  return {
    clientSenderName: typeof record.senderName === "string" ? record.senderName : null,
    clientNote: typeof record.note === "string" ? record.note : null,
  };
}

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
    ...clientUploadFields(item.metadata),
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

/**
 * Client-side list transforms for the paged media library
 * (2026-11-01 scale audit (W11)).
 *
 * `GET /api/media` pages by keyset, and the library also adds (upload) and
 * removes (delete) items locally rather than re-fetching. Between two page
 * fetches the underlying list can change, so the one invariant these helpers
 * hold is: the rendered list NEVER contains two items with the same `id`
 * (a duplicate React key and a visibly doubled card). Keyset paging already
 * avoids skipping or repeating rows when items are inserted or deleted between
 * pages; the de-dupe is the belt-and-braces for the local mutations (an item
 * prepended after upload that a later page also carries). Generic over
 * `{ id }` so they stay pure and framework-free (unit-tested in node).
 */

/**
 * Append a freshly-fetched OLDER page beneath the items already on screen,
 * dropping any id already present (existing rows come first, so the on-screen
 * copy wins) and any repeat within the page itself.
 */
export function appendMediaPage<T extends { id: string }>(existing: T[], page: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...existing, ...page]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Put a just-uploaded item at the top (the list is newest first). If an item
 * with the same id is already loaded, the fresh copy replaces it at the top
 * rather than rendering twice.
 */
export function prependMediaItem<T extends { id: string }>(existing: T[], created: T): T[] {
  return [created, ...existing.filter((item) => item.id !== created.id)];
}

/** Remove a deleted item locally; a no-op when that id isn't loaded. */
export function removeMediaItem<T extends { id: string }>(existing: T[], id: string): T[] {
  return existing.filter((item) => item.id !== id);
}

/**
 * The JSON body the media library POSTs to `/api/media` after the blob upload.
 *
 * 2026-11-02 scale audit (correctness): `workspaceId` is the workspace the page
 * was RENDERED for (not read from the cookie), so the route can answer 409
 * `WORKSPACE_CHANGED` when another tab switched workspace in between. The caption
 * is sent as typed; the route trims and caps it. A pure helper so the contract is
 * unit-tested in node (the component itself has no DOM test).
 */
export function buildMediaCreateBody(input: {
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    blobUrl: input.blobUrl,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    baseCaption: input.baseCaption,
    workspaceId: input.workspaceId,
  };
}
