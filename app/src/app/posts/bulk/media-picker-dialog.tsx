"use client";

import { useCallback, useEffect, useState } from "react";
import { Film } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { AnnouncedText } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/load-error";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toggleMediaSelection } from "@/lib/bulkMedia";
import { appendMediaPage, type MediaItemDto } from "@/lib/mediaDto";
import { withWorkspaceId } from "@/lib/workspaceChanged";

/**
 * A Media item in its controls' names: its place in the shown grid and its full
 * file name, as /u's rows are named ("3. IMG_0001.JPG"). R58 pages-a-2 L1: two
 * items often share a file name. R59 fix review L1: the upload time (minute
 * precision) and a cut name (40 characters) still let names repeat; the place
 * can't.
 */
export function pickerItemName(item: Pick<MediaItemDto, "originalFilename">, position: number): string {
  return `${position}. ${item.originalFilename}`;
}

interface MediaPickerDialogProps {
  /** R32: the workspace Add many was drawn for; every page read sends it. */
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Items already added as rows: shown ticked and locked, so none is added twice. */
  addedIds: ReadonlySet<string>;
  /** Rows still free in the batch. */
  room: number;
  onAdd: (items: MediaItemDto[]) => void;
}

interface Page {
  items: MediaItemDto[];
  nextCursor: string | null;
}

/** The first page failed: nothing is listed or ticked yet. */
export const FIRST_LOAD_FAILED_MESSAGE = "Your media could not be loaded. Close this and try again.";
/** R30 pages L5: a later page failed; the list, its ticks and Load more are still there. */
export const LOAD_MORE_FAILED_MESSAGE = "Couldn't load more. Press Load more to try again.";

/**
 * A page of the library of the workspace Add many was drawn for (R32
 * publishing L1: a tab left on it after another tab switched is refused, and
 * the picker says the route's sentence instead of listing the other library).
 */
export function mediaPageUrl(workspaceId: string, cursor: string | null): string {
  return withWorkspaceId(cursor ? `/api/media?cursor=${encodeURIComponent(cursor)}` : "/api/media", workspaceId);
}

/** The picker's line once its list is shown; Load more changes it, so it is read again. */
export function mediaCountLine(count: number): string {
  return count === 1 ? "Showing 1 photo or video." : `Showing ${count} photos and videos.`;
}

/** "Choose from Media": the workspace's photos and videos, newest first, paged like the Media page. */
export function MediaPickerDialog({ workspaceId, open, onOpenChange, addedIds, room, onAdd }: MediaPickerDialogProps) {
  const [items, setItems] = useState<MediaItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // The first load's failure, at the top; Load more's, under its button (R31 pages L1).
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(async (cursor: string | null, failed: string): Promise<Page | string> => {
    try {
      const response = await fetch(mediaPageUrl(workspaceId, cursor));
      const data = (await response.json().catch(() => null)) as
        | (Partial<Page> & { error?: string })
        | null;
      if (!response.ok) return data?.error ?? failed;
      return {
        items: Array.isArray(data?.items) ? data.items : [],
        nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null,
      };
    } catch {
      return failed;
    }
  }, [workspaceId]);

  // Loaded again each time the dialog opens, so an item the client just sent shows up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchPage(null, FIRST_LOAD_FAILED_MESSAGE).then((result) => {
      if (cancelled) return;
      if (typeof result === "string") {
        // R44 pages-a L2: the last opening's list is not this one's.
        setItems([]);
        setNextCursor(null);
        setError(result);
      } else {
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
      }
      setMoreError(null);
      setSelected(new Set());
      setLoading(false);
    });
    return () => {
      cancelled = true;
      setLoading(true);
      // R45 pages-a L1: the next opening starts without this one's failure.
      setError(null);
    };
  }, [open, fetchPage]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setMoreError(null);
    setLoadingMore(true);
    const result = await fetchPage(nextCursor, LOAD_MORE_FAILED_MESSAGE);
    if (typeof result === "string") setMoreError(result);
    else {
      setItems((current) => appendMediaPage(current, result.items));
      setNextCursor(result.nextCursor);
    }
    setLoadingMore(false);
  }

  const atLimit = selected.size >= room;

  function add() {
    onAdd(items.filter((item) => selected.has(item.id)));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="Choose from Media" className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Choose from Media</DialogTitle>
        <DialogDescription>
          Tick the photos and videos to add. {room} more can be added.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {/* R43 pages-a L6: the skeletons are hidden, so the loading line and
            then the result are read out (AnnouncedText). */}
        {loading ? (
          <>
            <AnnouncedText className="sr-only" text="Loading your media…" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="aspect-square w-full" />
              ))}
            </div>
          </>
        ) : items.length === 0 && !error ? (
          <AnnouncedText
            className="text-sm text-muted-foreground"
            text="Nothing in Media yet. Close this and choose photos and videos on this page, or upload them on the Media page."
          />
        ) : (
          <>
            {items.length > 0 && !error ? <AnnouncedText className="sr-only" text={mediaCountLine(items.length)} /> : null}
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {items.map((item, index) => {
                const added = addedIds.has(item.id);
                const checked = added || selected.has(item.id);
                const isVideo = item.mimeType.startsWith("video/");
                return (
                  <li key={item.id}>
                    <label
                      className={`relative block cursor-pointer overflow-hidden rounded-[var(--radius)] border ${
                        checked ? "border-primary ring-2 ring-primary" : "border-border"
                      }`}
                    >
                      <span className="relative block aspect-square w-full bg-muted">
                        {isVideo ? (
                          <>
                            <video
                              src={item.storageLocation}
                              muted
                              playsInline
                              preload="metadata"
                              tabIndex={-1}
                              aria-hidden
                              className="h-full w-full object-cover"
                            />
                            <Film
                              aria-hidden
                              className="absolute bottom-1 left-1 h-5 w-5 text-white drop-shadow-md"
                            />
                          </>
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element -- a stored public file; decorative next to its name
                          <img src={item.storageLocation} alt="" className="h-full w-full object-cover" />
                        )}
                      </span>
                      <span className="absolute left-1 top-1 rounded bg-background/90 p-1">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={checked}
                          disabled={added || (!checked && atLimit)}
                          onChange={() => setSelected((current) => toggleMediaSelection(current, item.id))}
                          aria-label={`Choose ${pickerItemName(item, index + 1)}`}
                        />
                      </span>
                      <span className="block p-2 text-xs">
                        <span className="block truncate font-medium text-foreground">{item.originalFilename}</span>
                        {item.clientSenderName !== undefined ? (
                          <span className="block truncate text-muted-foreground">
                            From {item.clientSenderName ?? "your client"}
                          </span>
                        ) : null}
                        {added ? <span className="block text-muted-foreground">Already added</span> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {nextCursor !== null && !loading ? (
          <div className="mt-4 flex flex-col items-center gap-2 text-center">
            {/* R34 publishing L1: after a workspace refusal the shared button is Reload page. */}
            <LoadMoreButton error={moreError} loading={loadingMore} onLoadMore={() => void loadMore()} />
            {moreError ? <p role="alert" className="text-sm text-destructive">{moreError}</p> : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={selected.size === 0} onClick={add}>
          {selected.size === 0 ? "Add" : `Add ${selected.size}`}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
