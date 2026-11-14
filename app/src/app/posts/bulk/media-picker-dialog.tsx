"use client";

import { useCallback, useEffect, useState } from "react";
import { Film } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

interface MediaPickerDialogProps {
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

/** "Choose from Media": the workspace's photos and videos, newest first, paged like the Media page. */
export function MediaPickerDialog({ open, onOpenChange, addedIds, room, onAdd }: MediaPickerDialogProps) {
  const [items, setItems] = useState<MediaItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(async (cursor: string | null): Promise<Page | string> => {
    try {
      const response = await fetch(cursor ? `/api/media?cursor=${encodeURIComponent(cursor)}` : "/api/media");
      const data = (await response.json().catch(() => null)) as
        | (Partial<Page> & { error?: string })
        | null;
      if (!response.ok) return data?.error ?? "Your media could not be loaded. Close this and try again.";
      return {
        items: Array.isArray(data?.items) ? data.items : [],
        nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null,
      };
    } catch {
      return "Your media could not be loaded. Close this and try again.";
    }
  }, []);

  // Loaded again each time the dialog opens, so an item the client just sent shows up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchPage(null).then((result) => {
      if (cancelled) return;
      if (typeof result === "string") {
        setError(result);
      } else {
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
      }
      setSelected(new Set());
      setLoading(false);
    });
    return () => {
      cancelled = true;
      setLoading(true);
    };
  }, [open, fetchPage]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await fetchPage(nextCursor);
    if (typeof result === "string") setError(result);
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
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="aspect-square w-full" />
            ))}
          </div>
        ) : items.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">
            Nothing in Media yet. Upload files here, or on the Media page.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {items.map((item) => {
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
                        aria-label={`Choose ${item.originalFilename}`}
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
        )}
        {nextCursor !== null && !loading ? (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
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
