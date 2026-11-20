"use client";

import { pageWorkspaceRefusalText } from "@/lib/workspaceChanged";
import { useRef } from "react";
import type { Platform } from "@prisma/client";
import { Film, Image as ImageIcon } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CharacterCount } from "@/components/ui/character-count";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VideoCoverPicker } from "@/components/video-cover-picker";
import { ALT_TEXT_MAX } from "@/lib/altText";
import { focusAfterPress } from "@/lib/focusAfter";
import { BULK_DRAFT_NO_TIME_TEXT, BULK_MAYBE_CREATED_MESSAGE, rowHoldsNoTime } from "@/lib/bulkPosts";
import { skippedForMediaLine } from "@/lib/postTargets";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { tooManyTriesSentence } from "@/lib/tooManyTriesText";
import { formatCoverTime, type CoverChoice } from "@/lib/videoCover";
import type { BulkRow } from "./bulk-posts-form";
import { routeSentenceAfter } from "./bulkExtras";

/**
 * R45 pages-a L3: a photo description counted as POST /api/posts stores it
 * (cleanAltText: line breaks as spaces, control characters gone, trimmed).
 * The route would cut a longer one, so the row is not sent instead.
 */
export function altTextStoredLength(text: string): number {
  return text
    .replace(/\r\n|[\r\n\t\v\f\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim().length;
}

export const ALT_TEXT_TOO_LONG_TEXT = `This photo's description can be up to ${ALT_TEXT_MAX.toLocaleString("en-US")} characters. Shorten it, then press again.`;

interface BulkPostRowProps {
  row: BulkRow;
  index: number;
  count: number;
  /** Chosen platforms this file goes past because they don't take its kind of file. */
  skipped: Platform[];
  /** True while the rows are being sent. */
  locked: boolean;
  /** Earliest schedulable time, as a datetime-local `min`. */
  minWhen: string;
  /** Why this row cannot be the Story chosen for the batch (rowStoryRefusal), or null. */
  storyRefusal: string | null;
  /** The row's send line as shown (rowSendLine): a server refusal, or a refused press while its check still refuses. */
  sendLine: string | null;
  /** R45 lead review: the description field, so a press refused for its length can focus it. */
  altFieldRef?: (field: HTMLInputElement | null) => void;
  /** This video row's cover picker is the one open (one at a time: the picker's ids are fixed). */
  coverOpen: boolean;
  /** "Write captions with AI" is on (F7). Off, no Write again: it would send the file to the AI. */
  aiCaptions?: boolean;
  onConfirmInQueue(): void;
  onSendAgain(): void;
  onCaptionChange(caption: string): void;
  onAltTextChange(altText: string): void;
  onWhenChange(when: string): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
  onRetry(): void;
  onWriteAgain(): void;
  onImprove(): void;
  /** A Media photo's "Write it for me". */
  onWriteDescription(): void;
  onCoverOpenChange(open: boolean): void;
  onCoverChange(cover: CoverChoice): void;
}

function coverSummary(cover: CoverChoice): string {
  if (cover.kind === "frame") return `Cover: frame at ${formatCoverTime(cover.timeMs)}`;
  if (cover.kind === "upload") return "Cover: your image";
  return "Cover: Platform default";
}

function Thumbnail({ row }: { row: BulkRow }) {
  const box =
    "flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius)] border border-border bg-muted text-muted-foreground";
  if (row.thumbnail) {
    return (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL or an inline video frame, which next/image cannot load; decorative next to the file name, so alt is empty */}
        <img src={row.thumbnail} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  const Icon = row.mimeType.startsWith("video/") ? Film : ImageIcon;
  return (
    <span className={box}>
      <Icon aria-hidden className="h-6 w-6" />
    </span>
  );
}

/**
 * What the row says when no caption came back (`status` null: no answer at
 * all). Only sentences written here for a person, for the causes they can act
 * on; the server's own text (a field name, a configuration or provider error)
 * is never shown, and the browser console keeps it.
 */
export function captionFailedText(status: number | null, code: unknown, waitSeconds?: number, routeError?: unknown): string {
  // R21 publishing-flow L1: the session ended (another tab, a new password);
  // asking again fails until the person signs in.
  if (status === 401) return SIGNED_OUT_ERROR;
  // R31: a page for another workspace, or from before the release.
  const workspaceText = pageWorkspaceRefusalText(code);
  if (workspaceText) return workspaceText;
  if (status === 504) {
    return "No caption was written: the AI service took too long. Write one yourself, or ask again.";
  }
  // R45 pages-a L4, L5: the daily limit is the route's own sentence, which says
  // whose budget ran out and the real wait.
  if (status === 429 && code === "AI_WORKSPACE_DAILY_LIMIT") {
    return (
      routeSentenceAfter("No caption was written", routeError) ??
      "No caption was written: the AI limit has been reached for now. Write one yourself."
    );
  }
  if (status === 429) {
    // R42 review: the limit's own wait (up to 15 minutes), in the routes' words, when the answer names it.
    return waitSeconds === undefined
      ? "No caption was written: too many requests. Wait a few minutes, then ask again, or write one yourself."
      : `No caption was written. ${tooManyTriesSentence(waitSeconds, "ask again, or write one yourself")}`;
  }
  // Paused, plan or trial ended, email unconfirmed: asking again fails until
  // that is fixed, and the page's own notice says how.
  if (status === 403) {
    return "No caption was written: this workspace can't use AI captions right now. See the notice at the top of the page.";
  }
  if (status === 413) {
    return "No caption was written: the file is too large for the AI to read. Write one yourself.";
  }
  return "No caption was written. Write one yourself, or ask again.";
}

function uploadText(row: BulkRow): string | null {
  if (row.upload === "queued") return "Waiting to upload";
  if (row.upload === "working") return row.progress === null ? "Preparing" : `Uploading ${Math.round(row.progress)}%`;
  return null;
}

/**
 * Whether the caption box takes no typing: Improve, or Write again (R27 MM4
 * review), replaces the text when it answers, so anything typed meanwhile
 * would be lost. The box stays focusable (read-only, not disabled); when the
 * AI fails the old text stays and the box unlocks.
 */
/** The row's caption failures, as one line; empty when there are none. */
function captionFailureLine(row: Pick<BulkRow, "captionStatus" | "captionError" | "improveError">): string {
  const failures = [row.captionStatus === "failed" ? row.captionError : null, row.improveError];
  return failures.filter((text): text is string => Boolean(text)).join(" ");
}

export function captionLocked(row: Pick<BulkRow, "improving" | "captionOverwrite" | "captionStatus">): boolean {
  return row.improving || (row.captionOverwrite && (row.captionStatus === "waiting" || row.captionStatus === "writing"));
}

export function BulkPostRow({
  row,
  index,
  count,
  skipped,
  locked,
  minWhen,
  storyRefusal,
  sendLine,
  altFieldRef,
  coverOpen,
  aiCaptions = true,
  onConfirmInQueue,
  onSendAgain,
  onCaptionChange,
  onAltTextChange,
  onWhenChange,
  onMove,
  onRemove,
  onRetry,
  onWriteAgain,
  onImprove,
  onWriteDescription,
  onCoverOpenChange,
  onCoverChange,
}: BulkPostRowProps) {
  const created = row.postId !== null;
  const editable = !created && !locked && !row.sending;
  const captionId = `bulk-caption-${row.id}`;
  const whenId = `bulk-when-${row.id}`;
  const altId = `bulk-alt-${row.id}`;
  const isPhoto = row.mimeType.startsWith("image/");
  const isVideo = row.mimeType.startsWith("video/");
  const status = uploadText(row);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const captionIsLocked = captionLocked(row);
  // R27 MM4: Write again hides both caption buttons and the old text stays, so this line says it is working.
  const rewriting = row.captionOverwrite && (row.captionStatus === "waiting" || row.captionStatus === "writing");

  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Thumbnail row={row} />
            <p className="min-w-0 break-words text-sm font-medium text-foreground">
              {index + 1}. {row.fileName}
            </p>
          </div>
          {!created ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="md"
                disabled={!editable || index === 0}
                onClick={() => onMove(-1)}
                aria-label={`Move ${row.fileName} up`}
              >
                Up
              </Button>
              <Button
                variant="outline"
                size="md"
                disabled={!editable || index === count - 1}
                onClick={() => onMove(1)}
                aria-label={`Move ${row.fileName} down`}
              >
                Down
              </Button>
              <Button variant="ghost" size="md" disabled={!editable} onClick={onRemove}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>

        {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}

        {row.upload === "failed" ? (
          <Alert variant="danger" title="This file did not upload.">
            <p>{row.uploadError}</p>
            <div className="mt-2 flex gap-2">
              {/* R48 publishing L4: a file refused for itself is refused on every Retry. */}
              {row.uploadErrorKind === "file" ? null : (
                <Button size="md" disabled={locked} onClick={onRetry}>
                  Retry
                </Button>
              )}
              <Button variant="outline" size="md" disabled={locked} onClick={onRemove}>
                Remove
              </Button>
            </div>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor={captionId}>Caption</Label>
          <Textarea
            ref={captionRef}
            id={captionId}
            rows={3}
            value={row.caption}
            disabled={!editable}
            // Improve and Write again replace the text when they answer, so nothing typed meanwhile is lost.
            readOnly={captionIsLocked}
            aria-readonly={captionIsLocked || undefined}
            placeholder={aiCaptions && row.captionStatus === "writing" ? "Writing a caption..." : "Write a caption"}
            onChange={(event) => {
              if (!captionIsLocked) onCaptionChange(event.target.value);
            }}
          />
          {/* R43 pages-a L4: one status line from the first render carries the
              work and both failures, so each failure is announced once. A new
              request empties it (the form clears both errors when one starts). */}
          <p role="status" id={`bulk-row-${row.id}-caption-status`} className="text-sm text-muted-foreground empty:sr-only">
            {rewriting ? "Writing a new caption..." : captionFailureLine(row)}
          </p>
          {editable && row.upload === "done" && (row.captionStatus === "done" || row.captionStatus === "failed") ? (
            <div className="flex flex-wrap gap-2">
              {aiCaptions ? (
                <Button
                  variant="outline"
                  size="md"
                  disabled={row.improving}
                  onClick={(event) => {
                    focusAfterPress(event.currentTarget, () => captionRef.current);
                    onWriteAgain();
                  }}
                >
                  Write again
                </Button>
              ) : null}
              {row.caption.trim() ? (
                <Button variant="outline" size="md" loading={row.improving} aria-busy={row.improving} onClick={onImprove}>
                  {row.improving ? "Improving..." : "Improve caption"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {isPhoto ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={altId}>Photo description (alt text)</Label>
            <Input
              ref={altFieldRef}
              id={altId}
              className="h-11"
              aria-describedby={`bulk-description-count-${row.id}`}
              value={row.altText}
              disabled={!editable}
              placeholder={row.altTextWriting ? "Writing a description..." : "What the photo shows, for screen readers"}
              onChange={(event) => onAltTextChange(event.target.value)}
            />
            <CharacterCount
              id={`bulk-description-count-${row.id}`}
              label="Photo description"
              text={row.altText}
              max={ALT_TEXT_MAX}
              count={altTextStoredLength}
              action="schedule or save this photo"
            />
            {/* A Media photo keeps its saved description unless the user writes
                a new one here: it is never described automatically. With "Write
                captions with AI" off, nothing goes to the AI, so no button. */}
            {row.mediaItemId && editable && aiCaptions ? (
              <div>
                <Button variant="outline" size="md" loading={row.altTextWriting} onClick={onWriteDescription}>
                  Write it for me
                </Button>
              </div>
            ) : null}
            {row.altTextError ? (
              <p className="text-sm text-muted-foreground" role="alert">
                {row.altTextError}
              </p>
            ) : null}
          </div>
        ) : null}

        {isVideo && row.blob && !created ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-foreground">{coverSummary(row.cover)}</p>
              {editable ? (
                <Button variant="outline" size="md" onClick={() => onCoverOpenChange(!coverOpen)}>
                  {coverOpen ? "Done" : "Change cover"}
                </Button>
              ) : null}
            </div>
            {coverOpen && editable ? (
              <VideoCoverPicker
                videoUrl={row.blob.url}
                durationSec={row.durationSec ?? null}
                value={row.cover}
                onChange={onCoverChange}
              />
            ) : null}
          </div>
        ) : null}

        {rowHoldsNoTime(row) ? (
          // R43 publishing-flow L1: a draft is saved without a time, so no date is shown.
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">Date and time</p>
            <p className="text-sm text-muted-foreground">{BULK_DRAFT_NO_TIME_TEXT}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={whenId}>Date and time</Label>
            <Input
              id={whenId}
              type="datetime-local"
              className="h-11 sm:max-w-xs"
              min={minWhen}
              value={row.when}
              // A row whose post may exist keeps the time it was sent with, so the
              // user looks for it in the Queue at that time (rowTimeLocked).
              disabled={!editable || row.uncertain}
              onChange={(event) => onWhenChange(event.target.value)}
            />
          </div>
        )}

        {skipped.length > 0 && !created ? (
          <p className="text-sm text-muted-foreground">{skippedForMediaLine(skipped, row.mimeType)}</p>
        ) : null}

        {storyRefusal && !created ? (
          <p className="text-sm text-destructive" role="alert">
            {storyRefusal}
          </p>
        ) : null}

        {/* R27 pages L9: one region from the first render; only what is in it changes. */}
        <div role="status" id={`bulk-row-${row.id}-send`} className="empty:sr-only">
          {row.sending ? <p className="text-sm text-muted-foreground">Sending...</p> : null}
          {row.result ? (
            <Alert variant="success" role={undefined}>
              {row.result}
            </Alert>
          ) : null}
        </div>
        {sendLine ? <Alert variant="danger">{sendLine}</Alert> : null}
        {row.uncertain ? (
          <Alert variant="warning">
            <p>{BULK_MAYBE_CREATED_MESSAGE}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="md" disabled={locked} onClick={onConfirmInQueue}>
                It is in the Queue
              </Button>
              <Button variant="outline" size="md" disabled={locked} onClick={onSendAgain}>
                Send again
              </Button>
            </div>
          </Alert>
        ) : null}
      </Card>
    </li>
  );
}
