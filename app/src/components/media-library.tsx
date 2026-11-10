"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  Copy,
  File as FileIcon,
  ImageOff,
  Images,
  PlayCircle,
  Repeat,
  Trash2,
} from "lucide-react";

import { CaptionCounter } from "@/components/caption-counter";
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
import { generateBlobKey } from "@/lib/blobKey";
import { captionCounter, captionTooLongMessage } from "@/lib/captionLimits";
import { isHeicFile, prepareUploadFile } from "@/lib/prepareUploadFile";
import { explainUploadFailure } from "@/lib/uploadFailure";
import {
  appendMediaPage,
  buildMediaCreateBody,
  daysUntilRemoval,
  prependMediaItem,
  removeMediaItem,
} from "@/lib/mediaDto";
import { RETENTION_DAYS } from "@/server/jobs/mediaRetention";

interface MediaItemDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  storageLocation: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Present only on a file sent through the client upload link (lib/mediaDto.ts). */
  clientSenderName?: string | null;
  clientNote?: string | null;
}

interface ListResponse {
  items: MediaItemDto[];
  /** Opaque `?cursor=` token for the next (older) page; null on the last page. */
  nextCursor: string | null;
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
  // null for a never-posted upload (retention-exempt — see
  // server/jobs/mediaRetention.ts); 0 means "eligible for removal now".
  const retentionDays = daysUntilRemoval(item.lastUsedAt, RETENTION_DAYS, new Date());

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
            {retentionDays !== null && (
              <>
                {" · "}
                {retentionDays === 0 ? "auto-removes soon" : `auto-removes in ${retentionDays} days`}
              </>
            )}
          </p>
          {item.clientSenderName !== undefined && (
            <>
              <p className="truncate text-xs font-medium text-foreground">
                From {item.clientSenderName ?? "your client"}
              </p>
              {item.clientNote ? (
                <p className="line-clamp-3 whitespace-pre-line break-words text-xs text-muted-foreground">
                  {item.clientNote}
                </p>
              ) : null}
            </>
          )}
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

interface UploadLinkDto {
  /** null when the stored token cannot be opened; Replace makes a new one. */
  url: string | null;
  uploadCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Client upload link (2026-11-10): owners make, copy, replace or turn off the
 * workspace's link here. The owner-only GET answers a member 403, and then the
 * panel is not shown at all. Every call carries the workspace this page was
 * rendered for: if another tab switched workspace, the routes answer 409 and
 * the panel shows their sentence instead of acting on the other workspace.
 */
function UploadLinkPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "hidden" | "ready" | "changed">("loading");
  const [changedMessage, setChangedMessage] = useState("");
  const [link, setLink] = useState<UploadLinkDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/workspaces/upload-link?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        const data = (await response.json().catch(() => null)) as
          | { link?: UploadLinkDto | null; error?: string }
          | null;
        if (cancelled) return;
        if (response.status === 409) {
          setChangedMessage(data?.error ?? "Reload this page.");
          setState("changed");
          return;
        }
        if (!response.ok) {
          setState("hidden");
          return;
        }
        setLink(data?.link ?? null);
        setState("ready");
      } catch {
        if (!cancelled) setState("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Create and Replace are the same call: the server revokes any old link.
  const makeLink = useCallback(async () => {
    const response = await fetch("/api/workspaces/upload-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const data = (await response.json().catch(() => null)) as
      | { link?: UploadLinkDto; error?: string }
      | null;
    if (!response.ok || !data?.link) {
      toast.error(data?.error ?? "Couldn't make the link. Try again.");
      throw new Error("CREATE_FAILED");
    }
    setLink(data.link);
    toast.success("New link ready. Copy it and send it to your client.");
  }, [toast, workspaceId]);

  const turnOff = useCallback(async () => {
    const response = await fetch("/api/workspaces/upload-link", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      // A 409 carries the library's "switched workspace" sentence: shown as is.
      toast.error(data?.error ?? "Couldn't turn the link off. Try again.");
      throw new Error("REVOKE_FAILED");
    }
    setLink(null);
    toast.success("The link is off. It no longer works.");
  }, [toast, workspaceId]);

  async function handleCreate() {
    setBusy(true);
    try {
      await makeLink();
    } catch {
      // Already shown as a toast.
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy the link. Copy it by hand instead.");
    }
  }

  if (state === "changed") {
    return (
      <Alert variant="warning" title="Client upload link">
        <p>{changedMessage}</p>
      </Alert>
    );
  }
  if (state !== "ready") return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Client upload link</CardTitle>
        <CardDescription>
          Give this link to a client. They can send photos and videos from their phone without an
          account, and the files land here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {link === null ? (
          <Button type="button" loading={busy} onClick={handleCreate}>
            Create link
          </Button>
        ) : (
          <>
            {link.url ? (
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={link.url}
                  aria-label="Client upload link"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyUrl}>
                  <Copy className="h-4 w-4" aria-hidden />
                  Copy
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This link can&apos;t be shown again. Replace it to get a new one.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {link.uploadCount === 1
                ? "1 file has come through this link."
                : `${link.uploadCount} files have come through this link.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("replace")}>
                Replace link
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("off")}>
                Turn off
              </Button>
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === "replace" ? "Replace the client upload link?" : "Turn off the client upload link?"}
        description={
          confirm === "replace"
            ? "The old link stops working. Anyone using it will need the new one."
            : "The old link stops working. Files already sent stay in your library."
        }
        confirmText={confirm === "replace" ? "Replace link" : "Turn off"}
        destructive
        onConfirm={confirm === "replace" ? makeLink : turnOff}
      />
    </Card>
  );
}

export function MediaLibrary({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const router = useRouter();

  const [items, setItems] = useState<MediaItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 2026-11-01 scale audit (W11): GET /api/media is paged (60 per page).
  // `nextCursor` is the opaque token for the next, older page — null once the
  // last page is loaded (which hides "Load more"); `loadingMore` guards and
  // spins that button.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [baseCaption, setBaseCaption] = useState("");
  // 2026-11-01 scale audit (jobs, event size): over the 10,000-character cap, which
  // POST /api/media rejects - blocks Upload (lib/captionLimits.ts).
  const captionOver = captionCounter(baseCaption).over;
  const [uploading, setUploading] = useState(false);
  // 0-100 while a Blob upload is in flight; null when idle. Mirrors
  // create-post-form.tsx's identically-named upload-progress state.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
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

      // First page only: replaces the list (this also serves Retry). Later
      // pages are appended by handleLoadMore below.
      const list = Array.isArray(data?.items) ? data!.items : [];
      setItems(list);
      setNextCursor(typeof data?.nextCursor === "string" ? data.nextCursor : null);
    } catch {
      setError("Unexpected error while loading media items.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    void fetchItems();
  }, [fetchItems]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    void fetchItems();
  }, [fetchItems]);

  // Fetches the next OLDER page and appends it, de-duped by id (a locally
  // prepended upload can also appear on a later page). The cursor is a
  // position in (createdAt desc, id desc), not a row reference, so deleting or
  // uploading items between pages neither skips nor repeats anything. A failed
  // fetch keeps the loaded list AND the cursor so the button stays for a retry.
  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/media?cursor=${encodeURIComponent(nextCursor)}`);
      const data = (await response.json().catch(() => null)) as
        | ListResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        toast.error((data as { error?: string } | null)?.error ?? "Failed to load more media.");
        return;
      }

      const page = data as ListResponse | null;
      const list = Array.isArray(page?.items) ? page.items : [];
      setItems((prev) => appendMediaPage(prev, list));
      setNextCursor(typeof page?.nextCursor === "string" ? page.nextCursor : null);
    } catch {
      toast.error("Unexpected error while loading more media.");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, toast]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!file) {
      toast.error("Please choose a file to upload.");
      return;
    }

    // Client-side guard first, ahead of the (bandwidth-costing) upload —
    // mirrors the server-side check in POST /api/media so a mismatched file
    // never reaches the blob store.
    // A HEIC photo the browser gave no type is converted below, not refused here.
    if (!isHeicFile(file) && !file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      toast.error("Only image or video files can be added to the library.");
      return;
    }

    // Same reason: an over-long caption would 400 AFTER the upload.
    if (captionOver) {
      toast.error(captionTooLongMessage("Caption"));
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // iPhone HEIC -> JPEG, big photos shrunk, unsupported types refused with
      // a clear message, all before the upload (lib/prepareUploadFile.ts).
      const prepared = await prepareUploadFile(file);
      // A full workspace storage reaches the user as its own sentence, not as
      // the blob client's generic token failure (lib/uploadFailure.ts).
      const blob = await upload(generateBlobKey(prepared), prepared, {
        access: "public",
        handleUploadUrl: "/api/upload",
        onUploadProgress: (progressEvent) => setUploadProgress(progressEvent.percentage),
      }).catch(async (uploadError: unknown) => {
        throw await explainUploadFailure(uploadError);
      });

      const response = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 2026-11-02 scale audit (correctness): sends the workspace this page was
        // rendered for, so an upload from a stale tab (workspace switched in
        // another tab) is refused with 409 and the server's message is toasted
        // below, instead of landing in the new workspace's library.
        body: JSON.stringify(
          buildMediaCreateBody({
            blobUrl: blob.url,
            filename: prepared.name,
            mimeType: prepared.type,
            sizeBytes: prepared.size,
            baseCaption,
            workspaceId,
          }),
        ),
      });

      const data = (await response.json().catch(() => null)) as
        | CreateResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        toast.error((data as { error?: string } | null)?.error ?? "Failed to upload media.");
        return;
      }

      const created = (data as CreateResponse).mediaItem;
      // No re-fetch: the new upload is the newest item, so it goes on top.
      setItems((prev) => prependMediaItem(prev, created));
      setFile(null);
      setBaseCaption("");
      setFileInputKey((key) => key + 1);
      toast.success("Media uploaded successfully.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unexpected error while uploading media.");
    } finally {
      setUploading(false);
      setUploadProgress(null);
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

    // No re-fetch of the list — just remove it client-side. nextCursor stays
    // valid even if `target` was the last loaded row (see handleLoadMore).
    setItems((prev) => removeMediaItem(prev, target.id));
    toast.success("Media deleted.");
  }, [deleteTarget, toast]);

  return (
    <div className="space-y-8">
      <UploadLinkPanel workspaceId={workspaceId} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload new media</CardTitle>
          <CardDescription>
            Add a video or image once, then reuse it across posts. Items you&apos;ve posted are
            removed automatically 30 days after their last use; never-posted uploads stay until
            you delete them.
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
                className="cursor-pointer"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                }}
              />
              {uploadProgress !== null && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Uploading&hellip;</span>
                    <span>{Math.round(uploadProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Upload progress"
                    aria-valuenow={Math.round(uploadProgress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-200"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="media-caption">Base caption</Label>
              <Textarea
                id="media-caption"
                value={baseCaption}
                onChange={(event) => setBaseCaption(event.target.value)}
                rows={3}
                placeholder="Optional base caption to reuse across posts"
                aria-invalid={captionOver || undefined}
                aria-describedby="media-caption-count"
              />
              <CaptionCounter id="media-caption-count" text={baseCaption} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" loading={uploading} disabled={captionOver}>
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
          <>
            <p role="status" className="sr-only">Loading media library…</p>
            <div
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
              aria-hidden
            >
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="aspect-square w-full" />
              ))}
            </div>
          </>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your media">
            <div className="flex flex-col items-start gap-3">
              <p>{error}</p>
              <Button size="sm" variant="outline" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : items.length === 0 && nextCursor === null ? (
          // Empty only when nothing is loaded AND no older page remains: after
          // deleting every loaded item there can still be more behind the cursor.
          <EmptyState
            icon={<Images />}
            title="No media yet"
            description="Upload from Create post, or use the form above, to build your library."
          />
        ) : (
          <>
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
            {nextCursor !== null ? (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" size="sm" loading={loadingMore} onClick={handleLoadMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
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
