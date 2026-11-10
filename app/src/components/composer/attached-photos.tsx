"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { UploadedBlob } from "@/lib/createPostRequest";

/**
 * The Create page's attached photos (07c): a row of thumbnails, each with
 * remove, move-earlier and move-later buttons (buttons, not drag and drop:
 * the page is used on phones), plus the set's upload logic. The list rules
 * (limit, types, moves) live in lib/postMedia.ts.
 */

export interface AttachedPhoto {
  /** Stable id for the list, independent of order. */
  key: string;
  /** The prepared file (HEIC already converted, big photos shrunk). */
  file: File;
  status: "waiting" | "uploading" | "uploaded" | "failed";
  /** 0-100 while uploading. */
  progress: number;
  blob: UploadedBlob | null;
  /** The sentence to show for a failed upload. */
  error: string | null;
}

/** The list with that photo changed; the same list if it was removed meanwhile. */
export function patchPhoto(
  list: AttachedPhoto[],
  key: string,
  patch: Partial<AttachedPhoto>,
): AttachedPhoto[] {
  if (!list.some((photo) => photo.key === key)) return list;
  return list.map((photo) => (photo.key === key ? { ...photo, ...patch } : photo));
}

/** Publish waits until every attached photo is uploaded. */
export function photoSetReady(photos: readonly AttachedPhoto[]): boolean {
  return photos.length > 0 && photos.every((photo) => photo.status === "uploaded" && photo.blob !== null);
}

/** Progress for the set while any photo is waiting or uploading, else null. */
export function photoSetProgress(
  photos: readonly AttachedPhoto[],
): { done: number; total: number; percent: number } | null {
  if (!photos.some((photo) => photo.status === "waiting" || photo.status === "uploading")) return null;
  const done = photos.filter((photo) => photo.status === "uploaded").length;
  const inFlight = photos.find((photo) => photo.status === "uploading")?.progress ?? 0;
  return {
    done,
    total: photos.length,
    percent: Math.round(((done + inFlight / 100) / photos.length) * 100),
  };
}

export interface UploadPhotosDeps {
  /** Uploads one file, rejecting with the sentence to show (lib/uploadFailure.ts). */
  upload(file: File, onProgress: (percent: number) => void): Promise<UploadedBlob>;
  /** True once a newer pick replaced this set: stop uploading. */
  isStale(): boolean;
  onUpdate(key: string, patch: Partial<AttachedPhoto>): void;
  onUploaded?(key: string, blob: UploadedBlob): void;
}

const UPLOAD_FAILED_FALLBACK = "This photo didn't upload. Retry it or remove it.";

/**
 * Upload the photos one after another (never in parallel, so a phone's
 * connection isn't split ten ways). A failure marks that photo and moves on;
 * it never rejects.
 */
export async function uploadPhotosInOrder(
  entries: readonly { key: string; file: File }[],
  deps: UploadPhotosDeps,
): Promise<void> {
  for (const { key, file } of entries) {
    if (deps.isStale()) return;
    deps.onUpdate(key, { status: "uploading", progress: 0, error: null });
    try {
      const blob = await deps.upload(file, (percent) => {
        if (!deps.isStale()) deps.onUpdate(key, { progress: percent });
      });
      if (deps.isStale()) return;
      deps.onUpdate(key, { status: "uploaded", blob, error: null });
      deps.onUploaded?.(key, blob);
    } catch (error: unknown) {
      if (deps.isStale()) return;
      const message = error instanceof Error && error.message ? error.message : UPLOAD_FAILED_FALLBACK;
      deps.onUpdate(key, { status: "failed", error: message, blob: null });
    }
  }
}

export interface AttachedPhotosProps {
  photos: readonly AttachedPhoto[];
  onRemove(key: string): void;
  onMove(key: string, direction: -1 | 1): void;
  onRetry(key: string): void;
}

export function AttachedPhotos({ photos, onRemove, onMove, onRetry }: AttachedPhotosProps) {
  const progress = photoSetProgress(photos);
  return (
    <div className="mt-2 space-y-2">
      <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Attached photos">
        {photos.map((photo, index) => (
          <PhotoTile
            key={photo.key}
            photo={photo}
            position={index + 1}
            isFirst={index === 0}
            isLast={index === photos.length - 1}
            onRemove={() => onRemove(photo.key)}
            onMove={(direction) => onMove(photo.key, direction)}
            onRetry={() => onRetry(photo.key)}
          />
        ))}
      </ol>
      {progress && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{`Uploading photos… ${progress.done} of ${progress.total} done`}</span>
            <span>{`${progress.percent}%`}</span>
          </div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all duration-200"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius)] border border-input bg-background text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40";

function PhotoTile({
  photo,
  position,
  isFirst,
  isLast,
  onRemove,
  onMove,
  onRetry,
}: {
  photo: AttachedPhoto;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  onRetry(): void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(photo.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same object-URL pattern as create-post-form.tsx's preview: created and revoked with the file
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo.file]);

  return (
    <li className="w-24 shrink-0 space-y-1">
      <div className="relative h-24 w-24 overflow-hidden rounded-[var(--radius)] border border-border bg-muted">
        {url && (
          // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview; next/image would need remote host config
          <img src={url} alt={`Photo ${position}: ${photo.file.name}`} className="h-full w-full object-cover" />
        )}
        {isFirst && (
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 text-[10px] font-semibold leading-4 text-white">
            Cover
          </span>
        )}
        {photo.status === "uploading" || photo.status === "waiting" ? (
          <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[10px] leading-4 text-white">
            {photo.status === "uploading" ? `${Math.round(photo.progress)}%` : "Waiting"}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => onMove(-1)}
          disabled={isFirst}
          aria-label={`Move photo ${position} earlier`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => onMove(1)}
          disabled={isLast}
          aria-label={`Move photo ${position} later`}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onRemove}
          aria-label={`Remove photo ${position}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {photo.status === "failed" && (
        <div className="space-y-1" role="alert">
          <p className="text-xs text-destructive">{photo.error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Retry
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * "Add photos": picks more images to add to the ones attached. The input is
 * cleared after each pick so the same photo can be picked again.
 */
export function AddPhotosButton({
  onPick,
  disabled = false,
}: {
  onPick(files: File[]): void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "mt-2 cursor-pointer",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <ImagePlus className="h-4 w-4" aria-hidden />
      Add photos
      <input
        type="file"
        multiple
        accept="image/*"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
    </label>
  );
}
