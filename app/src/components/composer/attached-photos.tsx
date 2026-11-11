"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, Sparkles, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ALT_TEXT_MAX, cleanAltText } from "@/lib/altText";
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
  /**
   * The prepared file (HEIC already converted, big photos shrunk); the picked
   * file while `preparing`.
   */
  file: File;
  status: "preparing" | "waiting" | "uploading" | "uploaded" | "failed";
  /** 0-100 while uploading. */
  progress: number;
  blob: UploadedBlob | null;
  /** The sentence to show for a failed upload. */
  error: string | null;
  /**
   * 07d: the photo's description (alt text) as typed. Kept on the photo, so
   * removing or moving the photo takes its description with it.
   */
  altText?: string;
}

/**
 * 07d: the create body with each photo's cleaned description beside its file:
 * `altText` next to the single-file fields, or in each `media` entry. The
 * same body, untouched, when no photo has one.
 */
export function withPhotoDescriptions<T extends object>(body: T, descriptions: ReadonlyArray<string | undefined>): T {
  const cleaned = descriptions.map((text) => cleanAltText(text));
  if (!cleaned.some(Boolean)) return body;
  const media = (body as { media?: unknown }).media;
  if (Array.isArray(media)) {
    return {
      ...body,
      media: media.map((entry: object, index) => (cleaned[index] ? { ...entry, altText: cleaned[index] } : entry)),
    };
  }
  return cleaned[0] ? { ...body, altText: cleaned[0] } : body;
}

/**
 * 07d: "Write it for me". Asks the AI caption route to describe the uploaded
 * photo (same quota as a caption). Rejects with the sentence to show.
 */
export async function requestPhotoDescription(
  blob: UploadedBlob,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl("/api/posts/auto-caption", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blobUrl: blob.url, mimeType: blob.mimeType, purpose: "altText" }),
  });
  const data = (await response.json().catch(() => null)) as { altText?: unknown; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" && data.error
        ? data.error
        : "The AI couldn't describe this photo. Try again or write it yourself.",
    );
  }
  if (typeof data?.altText !== "string" || !data.altText.trim()) {
    throw new Error("The AI didn't write a description. Try again or write it yourself.");
  }
  return data.altText;
}

/**
 * 07d: one photo's description: a one-line field with a character count, and
 * "Write it for me". `onWrite` is null until the photo has uploaded; a write
 * that resolves to null (the photo was replaced meanwhile) changes nothing.
 * What the AI wrote goes into the field for the person to edit.
 */
export function PhotoDescriptionField({
  id,
  label,
  value,
  onChange,
  onWrite,
}: {
  id: string;
  label: string;
  value: string;
  onChange(text: string): void;
  onWrite: (() => Promise<string | null>) | null;
}) {
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function write() {
    if (!onWrite) return;
    setWriting(true);
    setError(null);
    try {
      const text = await onWrite();
      if (text !== null) onChange(text);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "The AI couldn't describe this photo.");
    } finally {
      setWriting(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        <span id={`${id}-count`} className="text-xs text-muted-foreground">
          {`${value.length}/${ALT_TEXT_MAX}`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          maxLength={ALT_TEXT_MAX}
          onChange={(event) => onChange(event.target.value)}
          placeholder="What is in the photo, for someone who can't see it"
          aria-describedby={`${id}-count`}
          className="h-9"
        />
        <Button type="button" variant="outline" size="sm" onClick={write} loading={writing} disabled={writing || !onWrite}>
          {!writing && <Sparkles className="h-4 w-4" aria-hidden />}
          Write it for me
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
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

/**
 * Progress for the set while any photo is waiting or uploading, else null.
 * Null too while any is still being prepared: the row says "Preparing".
 */
export function photoSetProgress(
  photos: readonly AttachedPhoto[],
): { done: number; total: number; percent: number } | null {
  if (photos.some((photo) => photo.status === "preparing")) return null;
  if (!photos.some((photo) => photo.status === "waiting" || photo.status === "uploading")) return null;
  const done = photos.filter((photo) => photo.status === "uploaded").length;
  const inFlight = photos.find((photo) => photo.status === "uploading")?.progress ?? 0;
  return {
    done,
    total: photos.length,
    percent: Math.round(((done + inFlight / 100) / photos.length) * 100),
  };
}

export interface PreparePhotosDeps {
  /** prepareUploadFile: rejects with the sentence to show. */
  prepare(file: File): Promise<File>;
  /** True once a newer pick replaced this one, or the page was left. */
  isStale(): boolean;
  /** False once the user removed that placeholder. */
  isAttached(key: string): boolean;
}

/**
 * Prepare a pick's photos one after another, skipping a placeholder removed
 * meanwhile. Null when the pick went stale; a failed preparation rejects.
 */
export async function preparePhotos(
  entries: readonly { key: string; file: File }[],
  deps: PreparePhotosDeps,
): Promise<{ key: string; file: File }[] | null> {
  const prepared: { key: string; file: File }[] = [];
  for (const { key, file } of entries) {
    if (deps.isStale()) return null;
    if (!deps.isAttached(key)) continue;
    const ready = await deps.prepare(file);
    if (deps.isStale()) return null;
    if (deps.isAttached(key)) prepared.push({ key, file: ready });
  }
  return prepared;
}

export interface UploadPhotosDeps {
  /** Uploads one file, rejecting with the sentence to show (lib/uploadFailure.ts). */
  upload(file: File, onProgress: (percent: number) => void): Promise<UploadedBlob>;
  /** True once a newer pick replaced this set, or the page was left: stop. */
  isStale(): boolean;
  /** False once the user removed that photo: skip it, or drop its result. */
  isAttached(key: string): boolean;
  /** True while that photo is the first one attached. */
  isCover(key: string): boolean;
  onUpdate(key: string, patch: Partial<AttachedPhoto>): void;
  /**
   * Given: write the AI caption from this photo. Called at most once, for the
   * first photo of these entries to finish uploading while it is the cover.
   */
  onCaption?(key: string, blob: UploadedBlob, file: File): void;
  /** At the end, unless stale: whether `onCaption` was called. */
  onDone?(captionStarted: boolean): void;
}

const UPLOAD_FAILED_FALLBACK = "This photo didn't upload. Retry it or remove it.";

/**
 * Upload the photos one after another (never in parallel, so a phone's
 * connection isn't split ten ways). Each is checked against the current set
 * before it starts and again before its result is used. A failure marks that
 * photo and moves on; it never rejects.
 */
export async function uploadPhotosInOrder(
  entries: readonly { key: string; file: File }[],
  deps: UploadPhotosDeps,
): Promise<void> {
  let captionStarted = false;
  for (const { key, file } of entries) {
    if (deps.isStale()) return;
    if (!deps.isAttached(key)) continue;
    deps.onUpdate(key, { status: "uploading", progress: 0, error: null });
    try {
      const blob = await deps.upload(file, (percent) => {
        if (!deps.isStale() && deps.isAttached(key)) deps.onUpdate(key, { progress: percent });
      });
      if (deps.isStale()) return;
      if (!deps.isAttached(key)) continue;
      deps.onUpdate(key, { status: "uploaded", blob, error: null });
      if (deps.onCaption && !captionStarted && deps.isCover(key)) {
        captionStarted = true;
        deps.onCaption(key, blob, file);
      }
    } catch (error: unknown) {
      if (deps.isStale()) return;
      if (!deps.isAttached(key)) continue;
      const message = error instanceof Error && error.message ? error.message : UPLOAD_FAILED_FALLBACK;
      deps.onUpdate(key, { status: "failed", error: message, blob: null });
    }
  }
  deps.onDone?.(captionStarted);
}

/**
 * "Remove all" clears the main caption only when it is still exactly the text
 * the AI last wrote from the photos: a caption about removed photos must not
 * stay for the next ones. Typed or edited text is the user's and stays.
 */
export function removeAllClearsCaption(caption: string, lastAiCaption: string | null): boolean {
  return caption !== "" && lastAiCaption !== null && caption === lastAiCaption;
}

/** The question "Remove all" asks once before clearing the set. */
export function removeAllTitle(count: number, clearsCaption: boolean): string {
  return clearsCaption
    ? `Remove all ${count} photos? The caption written for them will be cleared too.`
    : `Remove all ${count} photos? Your caption stays.`;
}

export interface AttachedPhotosProps {
  photos: readonly AttachedPhoto[];
  onRemove(key: string): void;
  onMove(key: string, direction: -1 | 1): void;
  onRetry(key: string): void;
  /** Clears the set, after one confirmation. */
  onRemoveAll(): void;
  /** Whether "Remove all" will also clear the caption (removeAllClearsCaption). */
  removeAllClearsCaption: boolean;
  /** 07d: the photo's description changed (typed, or written by the AI). */
  onDescribe(key: string, text: string): void;
}

export function AttachedPhotos({
  photos,
  onRemove,
  onMove,
  onRetry,
  onRemoveAll,
  removeAllClearsCaption: clearsCaption,
  onDescribe,
}: AttachedPhotosProps) {
  const progress = photoSetProgress(photos);
  const preparing = photos.some((photo) => photo.status === "preparing");
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      {/* 07d: one description per photo, in the same order and numbering as the tiles. */}
      <ol className="space-y-2" aria-label="Photo descriptions">
        {photos.map((photo, index) => (
          <li key={photo.key}>
            <PhotoDescriptionField
              id={`alt-${photo.key}`}
              label={`Photo ${index + 1}: describe this photo (alt text)`}
              value={photo.altText ?? ""}
              onChange={(text) => onDescribe(photo.key, text)}
              onWrite={photo.blob ? () => requestPhotoDescription(photo.blob as UploadedBlob) : null}
            />
          </li>
        ))}
      </ol>
      {preparing && (
        <p className="text-xs text-muted-foreground" role="status">
          Preparing photos&hellip;
        </p>
      )}
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
      {photos.length >= 2 && (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
            Remove all
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title={removeAllTitle(photos.length, clearsCaption)}
            confirmText="Remove all"
            destructive
            onConfirm={onRemoveAll}
          />
        </>
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
        {photo.status === "uploading" || photo.status === "waiting" || photo.status === "preparing" ? (
          <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[10px] leading-4 text-white">
            {photo.status === "uploading"
              ? `${Math.round(photo.progress)}%`
              : photo.status === "preparing"
                ? "Preparing"
                : "Waiting"}
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
