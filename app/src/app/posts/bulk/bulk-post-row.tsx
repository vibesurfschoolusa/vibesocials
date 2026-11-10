"use client";

import type { Platform } from "@prisma/client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  onCaptionChange(caption: string): void;
  onWhenChange(when: string): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
  onRetry(): void;
  onWriteAgain(): void;
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
          <p className="min-w-0 break-words text-sm font-medium text-foreground">
            {index + 1}. {row.fileName}
          </p>
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
              No caption was written ({row.captionError}). Write one yourself, or ask again.
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
            value={row.when}
            disabled={!editable}
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
      </Card>
    </li>
  );
}
