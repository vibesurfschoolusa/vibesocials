import { BULK_MAX_FILES, filesThatFit } from "@/lib/bulkPosts";
import type { MediaItemDto } from "@/lib/mediaDto";

/**
 * Add many from the Media library (2026-11-14): the pure rules for picking
 * existing Media items as rows, and for the Media page's ?media= handoff.
 */

/** More ids than this in a link are ignored before any lookup. */
export const BULK_MEDIA_IDS_PARAM_MAX = 100;

export interface MediaPick {
  add: MediaItemDto[];
  /** Some picked items did not fit in the 20-row limit. */
  tooMany: boolean;
  /** Picked items left out because they are already rows. */
  duplicates: number;
}

/**
 * Which picked items become rows. Uploaded and picked rows share one limit of
 * 20, and an item that is already a row (or repeats in the pick) is added once.
 */
export function pickFromMedia(input: {
  rowCount: number;
  addedMediaIds: ReadonlySet<string>;
  picked: MediaItemDto[];
}): MediaPick {
  const seen = new Set(input.addedMediaIds);
  const fresh: MediaItemDto[] = [];
  let duplicates = 0;
  for (const item of input.picked) {
    if (seen.has(item.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(item.id);
    fresh.push(item);
  }
  const { take, tooMany } = filesThatFit(input.rowCount, fresh.length);
  return { add: fresh.slice(0, take), tooMany, duplicates };
}

export function toggleMediaSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The ids of a `?media=` value (a comma list, or the parameter repeated), once each. */
export function parseMediaIdsParam(raw: string | string[] | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids = parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set(ids)].slice(0, BULK_MEDIA_IDS_PARAM_MAX);
}

/** The Add many link for these Media items (at most 20 fit). */
export function bulkHandoffHref(ids: string[]): string {
  return `/posts/bulk?media=${encodeURIComponent(ids.slice(0, BULK_MAX_FILES).join(","))}`;
}

/**
 * The items to start Add many with: those of `requested` that `found` holds
 * (found is already limited to the workspace), in the order asked, up to 20.
 * Everything else, foreign, unknown or over the limit, is counted as skipped.
 */
export function resolveMediaHandoff(
  requested: string[],
  found: MediaItemDto[],
): { items: MediaItemDto[]; skipped: number } {
  const byId = new Map(found.map((item) => [item.id, item]));
  const items = requested
    .map((id) => byId.get(id))
    .filter((item): item is MediaItemDto => item !== undefined)
    .slice(0, BULK_MAX_FILES);
  return { items, skipped: requested.length - items.length };
}

export function skippedMediaMessage(skipped: number): string | null {
  if (skipped <= 0) return null;
  const subject = skipped === 1 ? "1 selected item was" : `${skipped} selected items were`;
  return `${subject} skipped: not in this workspace's Media, or past the limit of ${BULK_MAX_FILES}.`;
}
