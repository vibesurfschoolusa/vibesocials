"use client";

import type { Platform } from "@prisma/client";
import { Film, Image as ImageIcon } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BULK_MAYBE_CREATED_MESSAGE } from "@/lib/bulkPosts";
import { platformLabel } from "@/lib/platforms";
import type { BulkRow } from "./bulk-posts-form";

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
  onConfirmInQueue(): void;
  onSendAgain(): void;
  onCaptionChange(caption: string): void;
  onWhenChange(when: string): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
  onRetry(): void;
  onWriteAgain(): void;
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
export function captionFailedText(status: number | null, code: unknown): string {
  if (status === 504) {
    return "No caption was written: the AI service took too long. Write one yourself, or ask again.";
  }
  if (status === 429 && code === "AI_WORKSPACE_DAILY_LIMIT") {
    return "No caption was written: your workspace has reached today's AI limit. Write one yourself, or try again tomorrow.";
  }
  if (status === 429) {
    return "No caption was written: too many requests. Wait a few minutes, then ask again, or write one yourself.";
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

export function BulkPostRow({
  row,
  index,
  count,
  skipped,
  locked,
  minWhen,
  onConfirmInQueue,
  onSendAgain,
  onCaptionChange,
  onWhenChange,
  onMove,
  onRemove,
  onRetry,
  onWriteAgain,
}: BulkPostRowProps) {
  const created = row.postId !== null;
  const editable = !created && !locked && !row.sending;
  const captionId = `bulk-caption-${row.id}`;
  const whenId = `bulk-when-${row.id}`;
  const status = uploadText(row);

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
              <Button size="md" disabled={locked} onClick={onRetry}>
                Retry
              </Button>
              <Button variant="outline" size="md" disabled={locked} onClick={onRemove}>
                Remove
              </Button>
            </div>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor={captionId}>Caption</Label>
          <Textarea
            id={captionId}
            rows={3}
            value={row.caption}
            disabled={!editable}
            placeholder={row.captionStatus === "writing" ? "Writing a caption..." : "Write a caption"}
            onChange={(event) => onCaptionChange(event.target.value)}
          />
          {row.captionStatus === "failed" ? (
            <p className="text-sm text-muted-foreground">
              {row.captionError ?? captionFailedText(null, undefined)}
            </p>
          ) : null}
          {editable && row.upload === "done" && (row.captionStatus === "done" || row.captionStatus === "failed") ? (
            <div>
              <Button variant="outline" size="md" onClick={onWriteAgain}>
                Write again
              </Button>
            </div>
          ) : null}
        </div>

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

        {skipped.length > 0 && !created ? (
          <p className="text-sm text-muted-foreground">
            Skips {skipped.map(platformLabel).join(", ")}: they do not take this kind of file.
          </p>
        ) : null}

        {row.sending ? <p className="text-sm text-muted-foreground">Sending...</p> : null}
        {row.result ? <Alert variant="success">{row.result}</Alert> : null}
        {row.sendError ? <Alert variant="danger">{row.sendError}</Alert> : null}
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
