"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ALT_TEXT_MAX, cleanAltText } from "@/lib/altText";
import { cn } from "@/lib/cn";
import { focusAfterPress } from "@/lib/focusAfter";
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import type { UploadedBlob } from "@/lib/createPostRequest";
import { prepareUploadFile, type PrepareUploadDeps } from "@/lib/prepareUploadFile";

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
 * 07d: where a "Write it for me" answer for the single photo goes once it comes
 * back. "Add photos" may have moved the photo into the set meanwhile (the set
 * keeps the same File), or the photo may be gone. `photo` is the File (or the
 * reused item) it was asked for; `single` is what the single field shows now.
 */
export function whereDescriptionGoes(
  photo: object,
  now: { single: object | null; set: readonly AttachedPhoto[] },
): { to: "single" } | { to: "set"; key: string } | null {
  const inSet = now.set.find((entry) => entry.file === photo);
  if (inSet) return { to: "set", key: inSet.key };
  return now.single === photo ? { to: "single" } : null;
}

/**
 * R37 publishing L1: the media a caption is asked about, by the rule above:
 * a set's cover File, else the single File or the reused item. "Add photos"
 * moves the single File into the set as its cover, which is the same media.
 */
export function selectedMediaOf(now: { single: object | null; set: readonly AttachedPhoto[] }): object | null {
  return now.set[0]?.file ?? now.single;
}

/** Lead review 3 (R28 NN2): on a lost answer the AI ran and used the allowance; only its answer is missing, and nothing is saved. */
export const PHOTO_DESCRIPTION_OFFLINE_MESSAGE = answerLostText("the description isn't shown", "Nothing was saved; try again.");
export const PHOTO_DESCRIPTION_FAILED_MESSAGE =
  "Something went wrong on our side, so no description was written. Please try again in a minute.";
const PHOTO_DESCRIPTION_EMPTY_MESSAGE = "The AI didn't write a description. Try again or write it yourself.";

/**
 * 07d: "Write it for me". Asks the AI caption route to describe the uploaded
 * photo (same quota as a caption). Rejects with the sentence to show: the
 * route's own refusal, or ours when the request never left or the answer is
 * not JSON (R25 new-customer L3, as requestCaption does it).
 */
export async function requestPhotoDescription(
  blob: UploadedBlob,
  /** R31: the workspace the page was drawn for (null: none yet, left out). */
  workspaceId: string | null,
  fetchImpl: typeof fetch = fetch,
  /** R40: Create's hold on the request (useCaptionBox); aborting it reads as a lost answer. */
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchOrNoAnswer(
      "/api/posts/auto-caption",
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          mimeType: blob.mimeType,
          purpose: "altText",
          ...(workspaceId ? { workspaceId } : {}),
        }),
      },
      fetchImpl,
    );
  } catch {
    throw new Error(PHOTO_DESCRIPTION_OFFLINE_MESSAGE);
  }
  const data = (await response.json().catch(() => null)) as { altText?: unknown; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" && data.error ? data.error : PHOTO_DESCRIPTION_FAILED_MESSAGE);
  }
  if (data === null || typeof data !== "object") throw new Error(PHOTO_DESCRIPTION_FAILED_MESSAGE);
  if (typeof data.altText !== "string" || !data.altText.trim()) {
    throw new Error(PHOTO_DESCRIPTION_EMPTY_MESSAGE);
  }
  return data.altText;
}

/**
 * 07d: one photo's description: a one-line field with a character count, and
 * "Write it for me". `onWrite` is null until the photo has uploaded; a write
 * that resolves to null (the photo was replaced meanwhile, or R41 L1 its
 * description was edited) changes nothing.
 * What the AI wrote goes into the field for the person to edit.
 */
export function PhotoDescriptionField({
  id,
  label,
  value,
  onChange,
  onWrite,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange(text: string): void;
  onWrite: (() => Promise<string | null>) | null;
  /** R65: Create's send lock (sendLocksFields): the field and its button can't change the post. */
  disabled?: boolean;
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
          disabled={disabled}
          placeholder="What is in the photo, for someone who can't see it"
          aria-describedby={`${id}-count`}
          className="h-9"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={write}
          aria-label={`Write it for me: ${label}`}
          loading={writing} disabled={!onWrite || disabled}
        >
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
 * R48 pages-b L1: one photo of a pick of several, prepared as on Create's
 * single pick, with every refusal naming the file and the pick's step.
 * `deps` for tests.
 */
export function preparePickedPhoto(file: File, deps?: PrepareUploadDeps): Promise<File> {
  return prepareUploadFile(file, deps, "photoPick");
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
  upload(file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<UploadedBlob>;
  /**
   * R62 publishing-flow-2 L1: the caller's map of the photo uploading now, by
   * key, so removing it aborts its bytes and the next photo starts.
   */
  aborts?: Map<string, AbortController>;
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
    const abort = new AbortController();
    deps.aborts?.set(key, abort);
    try {
      const blob = await deps.upload(
        file,
        (percent) => {
          if (!deps.isStale() && deps.isAttached(key)) deps.onUpdate(key, { progress: percent });
        },
        abort.signal,
      );
      if (deps.isStale()) return;
      if (!deps.isAttached(key)) continue;
      deps.onUpdate(key, { status: "uploaded", blob, error: null });
      if (deps.onCaption && !captionStarted && deps.isCover(key)) {
        captionStarted = true;
        deps.onCaption(key, blob, file);
      }
    } catch (error: unknown) {
      if (deps.isStale()) return;
      // Removed (and so aborted): nothing to say, and the next photo starts.
      if (abort.signal.aborted || !deps.isAttached(key)) continue;
      const message = error instanceof Error && error.message ? error.message : UPLOAD_FAILED_FALLBACK;
      deps.onUpdate(key, { status: "failed", error: message, blob: null });
    } finally {
      if (deps.aborts?.get(key) === abort) deps.aborts.delete(key);
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

/**
 * R37 new-customer L1: the one "the media changed" rule. Whenever the selected
 * media is replaced or dropped (a new pick, Remove all, the last photo removed,
 * "Use a different file instead"), a caption the AI wrote for it, still
 * unedited, goes with it, and lastAiCaption too. Typed or edited text stays.
 */
export function captionAfterMediaChange(
  caption: string,
  lastAiCaption: string | null,
): { caption: string; lastAiCaption: string | null } {
  return removeAllClearsCaption(caption, lastAiCaption) ? { caption: "", lastAiCaption: null } : { caption, lastAiCaption };
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
  /**
   * "Write it for me" for one uploaded photo: Create's, which holds the submit
   * while it runs (R40 publishing L3) and lets go once `photo` is removed.
   * Null: nothing to write.
   */
  writeDescription(blob: UploadedBlob, photo: File): Promise<string | null>;
  /**
   * R65 publishing-flow L2: Create's send lock (sendLocksFields). Every control
   * that changes the set or its descriptions is disabled. A prop, not a
   * wrapping fieldset, so the set's own mt-2 keeps its gap.
   */
  disabled?: boolean;
}

export function AttachedPhotos({
  photos,
  onRemove,
  onMove,
  onRetry,
  onRemoveAll,
  removeAllClearsCaption: clearsCaption,
  onDescribe,
  writeDescription,
  disabled = false,
}: AttachedPhotosProps) {
  const progress = photoSetProgress(photos);
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
            disabled={disabled}
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
              onWrite={photo.blob ? () => writeDescription(photo.blob as UploadedBlob, photo.file) : null}
              disabled={disabled}
            />
          </li>
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
      {photos.length >= 2 && (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(true)} disabled={disabled}>
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
  disabled,
}: {
  photo: AttachedPhoto;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  onRetry(): void;
  disabled: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const earlierRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
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
          ref={earlierRef}
          type="button"
          className={ICON_BUTTON}
          onClick={(event) => {
            // R27 MM4: at an end the pressed arrow is disabled; focus goes to the other one.
            focusAfterPress(event.currentTarget, () => laterRef.current);
            onMove(-1);
          }}
          disabled={isFirst || disabled}
          aria-label={`Move photo ${position} earlier`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          ref={laterRef}
          type="button"
          className={ICON_BUTTON}
          onClick={(event) => {
            focusAfterPress(event.currentTarget, () => earlierRef.current);
            onMove(1);
          }}
          disabled={isLast || disabled}
          aria-label={`Move photo ${position} later`}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onRemove}
          disabled={disabled}
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
            disabled={disabled}
            aria-label={`Retry photo ${position}`}
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
 * R28 new-customer addendum L9: "Preparing photos…", drawn by the page around
 * the set (Create) so it is on the page before the first pick: the set mounts
 * with its photos already preparing, and a status that appears filled may not
 * be announced. Only its text changes.
 */
export function PreparingPhotosStatus({ photos }: { photos: readonly AttachedPhoto[] }) {
  const preparing = photos.some((photo) => photo.status === "preparing");
  return (
    <p className="text-xs text-muted-foreground empty:sr-only" role="status">
      {preparing ? "Preparing photos…" : ""}
    </p>
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
        // R28 new-customer addendum L8: the real input is visually hidden, so
        // the label shows the keyboard focus ring for it.
        "mt-2 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
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
