"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  File as FileIcon,
  ImageOff,
  Images,
  PlayCircle,
  Repeat,
  Trash2,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

interface MediaItemDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  storageLocation: string;
  createdAt: string;
}

interface ListResponse {
  items: MediaItemDto[];
}

interface CreateResponse {
  mediaItem: MediaItemDto;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

/** Thumbnail for a single item: image preview, video frame + play affordance,
 * or a generic file icon fallback. Opens the stored file in a new tab (the
 * existing public storage URL — no new endpoint required). */
function MediaThumbnail({ item }: { item: MediaItemDto }) {
  const [imageFailed, setImageFailed] = useState(false);
  const isImage = item.mimeType.startsWith("image/");
  const isVideo = item.mimeType.startsWith("video/");

  return (
    <a
      href={item.storageLocation}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${item.originalFilename}`}
      className="relative block aspect-square w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {isImage && !imageFailed ? (
        <Image
          src={item.storageLocation}
          alt=""
          fill
          unoptimized
          sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
          className="object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : isVideo ? (
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
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/15"
          >
            <PlayCircle className="h-10 w-10 text-white drop-shadow-md" />
          </div>
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          {isImage ? (
            <ImageOff aria-hidden className="h-8 w-8" />
          ) : (
            <FileIcon aria-hidden className="h-8 w-8" />
          )}
        </div>
      )}
    </a>
  );
}

interface MediaCardProps {
  item: MediaItemDto;
  onReuse: (item: MediaItemDto) => void;
  onDeleteRequest: (item: MediaItemDto) => void;
}

function MediaCard({ item, onReuse, onDeleteRequest }: MediaCardProps) {
  return (
    <Card className="overflow-hidden">
      <MediaThumbnail item={item} />
      <div className="space-y-2 p-3">
        <div className="space-y-0.5">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={item.originalFilename}
          >
            {item.originalFilename}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(item.sizeBytes)}
            {" · "}
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleDateString()}
            </time>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onReuse(item)}
          >
            <Repeat className="h-3.5 w-3.5" aria-hidden />
            Use in new post
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${item.originalFilename}`}
            onClick={() => onDeleteRequest(item)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function MediaLibrary() {
  const toast = useToast();
  const router = useRouter();

  const [items, setItems] = useState<MediaItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [baseCaption, setBaseCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);

  // Delete confirmation (Roadmap Phase 2). `deleteTarget` doubles as the
  // dialog's open/closed flag (open whenever it's non-null) so there's no
  // separate boolean to keep in sync.
  const [deleteTarget, setDeleteTarget] = useState<MediaItemDto | null>(null);

  // Does the actual fetch/parse. Deliberately does NOT reset `loading`/`error`
  // at the top: `loading`/`error` already start `true`/`null` from useState,
  // so the mount-time effect below never calls setState synchronously within
  // the effect body itself (that would trip react-hooks/set-state-in-effect)
  // — the first state update happens only after the `await` below. The
  // Retry button (a normal event handler, not an effect) resets the state
  // itself before calling this. `setLoading(false)` lives in `finally` (a
  // single call site) so every exit path — success, handled error, thrown
  // error — clears it the same way.
  const fetchItems = useCallback(async () => {
    try {
      const response = await fetch("/api/media");
      const data = (await response.json().catch(() => null)) as ListResponse | null;

      if (!response.ok) {
        setError((data as { error?: string } | null)?.error ?? "Failed to load media items.");
        return;
      }

      const list = Array.isArray(data?.items) ? data!.items : [];
      setItems(list);
    } catch (_err) {
      setError("Unexpected error while loading media items.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    void fetchItems();
  }, [fetchItems]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!file) {
      toast.error("Please choose a file to upload.");
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("baseCaption", baseCaption);

      const response = await fetch("/api/media", {
        method: "POST",
        body: formData,
      });

      const data = (await response.json().catch(() => null)) as
        | CreateResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        toast.error((data as { error?: string } | null)?.error ?? "Failed to upload media.");
        setUploading(false);
        return;
      }

      const created = (data as CreateResponse).mediaItem;
      setItems((prev) => [created, ...prev]);
      setFile(null);
      setBaseCaption("");
      setFileInputKey((key) => key + 1);
      toast.success("Media uploaded successfully.");
      setUploading(false);
    } catch (_err) {
      toast.error("Unexpected error while uploading media.");
      setUploading(false);
    }
  }

  // Roadmap Phase 2: "Use in new post" hands off to the composer's reuse
  // mode via a query param — no local state needed here.
  const handleReuse = useCallback(
    (item: MediaItemDto) => {
      router.push(`/posts/new?mediaItemId=${encodeURIComponent(item.id)}`);
    },
    [router],
  );

  const handleDeleteRequest = useCallback((item: MediaItemDto) => {
    setDeleteTarget(item);
  }, []);

  // Passed as ConfirmDialog's `onConfirm`: it awaits this (showing a busy
  // state) and only closes the dialog if it resolves without throwing — so
  // every failure path below throws AFTER toasting, which keeps the dialog
  // open for the user to retry (see ConfirmDialog's own doc comment).
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;

    let response: Response;
    try {
      response = await fetch(`/api/media/${target.id}`, { method: "DELETE" });
    } catch {
      toast.error("Unexpected error while deleting media.");
      throw new Error("DELETE_FAILED");
    }

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      // Covers the 409 "still referenced by an active post" case: the
      // server's message already states the reason, so it's shown as-is.
      toast.error(data?.error ?? "Failed to delete media.");
      throw new Error("DELETE_FAILED");
    }

    // No re-fetch of the whole list — just remove it client-side.
    setItems((prev) => prev.filter((existing) => existing.id !== target.id));
    toast.success("Media deleted.");
  }, [deleteTarget, toast]);

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload new media</CardTitle>
          <CardDescription>
            Add a video or image once, then reuse it across posts and platforms.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="media-file">File</Label>
              <Input
                key={fileInputKey}
                id="media-file"
                type="file"
                accept="video/*,image/*"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="media-caption">Base caption</Label>
              <Textarea
                id="media-caption"
                value={baseCaption}
                onChange={(event) => setBaseCaption(event.target.value)}
                rows={3}
                placeholder="Optional base caption to reuse across posts"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" loading={uploading}>
                Upload
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="your-media-heading">
        <h2
          id="your-media-heading"
          className="mb-4 text-lg font-semibold text-foreground"
        >
          Your media
        </h2>

        {loading ? (
          <div
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
            aria-hidden
          >
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="aspect-square w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your media">
            <div className="flex flex-col items-start gap-3">
              <p>{error}</p>
              <Button size="sm" variant="outline" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Images />}
            title="No media yet"
            description="Upload from Create post, or use the form above, to build your library."
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                onReuse={handleReuse}
                onDeleteRequest={handleDeleteRequest}
              />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this media?"
        description={
          deleteTarget
            ? `"${deleteTarget.originalFilename}" will be removed from your library and can't be used in new posts. This can't be undone.`
            : undefined
        }
        destructive
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
