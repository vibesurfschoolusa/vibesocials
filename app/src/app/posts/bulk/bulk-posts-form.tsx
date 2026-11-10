"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import type { Platform } from "@prisma/client";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnections } from "@/hooks/useConnections";
import { generateBlobKey } from "@/lib/blobKey";
import {
  BULK_MAX_FILES,
  BULK_NO_TIME_MESSAGE,
  BULK_TIKTOK_NOTE,
  BULK_TOO_MANY_FILES_MESSAGE,
  type BulkCaptionStatus,
  type BulkFinishMode,
  type BulkScheduleControls,
  type BulkUploadStatus,
  allRowsCreated,
  applySchedule,
  captionProgressText,
  filesThatFit,
  moveRow,
  nextWork,
  platformsForRow,
  rowSendBlock,
  sendResultFromResponse,
  tomorrowLocalDate,
} from "@/lib/bulkPosts";
import { buildUploadPostBody, type UploadedBlob } from "@/lib/createPostRequest";
import { extractVideoFrames } from "@/lib/extractVideoFrames";
import { PLATFORM_ORDER, platformLabel, SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import { prepareUploadFile } from "@/lib/prepareUploadFile";
import { localDateTimeToUtcIso, localTimeZoneLabel } from "@/lib/scheduling";
import { explainUploadFailure } from "@/lib/uploadFailure";
import { BulkPostRow } from "./bulk-post-row";

export interface BulkRow {
  id: string;
  fileName: string;
  mimeType: string;
  upload: BulkUploadStatus;
  /** 0-100 while uploading. */
  progress: number | null;
  uploadError: string | null;
  blob: UploadedBlob | null;
  caption: string;
  captionStatus: BulkCaptionStatus;
  /** Set by "Write again": the new caption replaces what is in the box. */
  captionOverwrite: boolean;
  captionError: string | null;
  /** datetime-local value. */
  when: string;
  whenSetByHand: boolean;
  /** The created post's id; a row that has one is never sent again. */
  postId: string | null;
  sending: boolean;
  result: string | null;
  sendError: string | null;
}

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and press the button again.";

function newRow(file: File): BulkRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    fileName: file.name,
    mimeType: file.type,
    upload: "queued",
    progress: null,
    uploadError: null,
    blob: null,
    caption: "",
    captionStatus: "waiting",
    captionOverwrite: false,
    captionError: null,
    when: "",
    whenSetByHand: false,
    postId: null,
    sending: false,
    result: null,
    sendError: null,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function BulkPostsForm({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<BulkRow[]>([]);
  // The latest rows, for the async upload/caption/send loops (state read inside
  // them would be the value from when they started).
  const rowsRef = useRef<BulkRow[]>([]);
  const filesRef = useRef(new Map<string, File>());
  const workingRef = useRef(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [tooMany, setTooMany] = useState(false);
  const [sendingMode, setSendingMode] = useState<BulkFinishMode | null>(null);

  const [controls, setControls] = useState<BulkScheduleControls>(() => ({
    firstDay: tomorrowLocalDate(new Date()),
    timeOfDay: "18:00",
    everyDays: 1,
  }));
  const controlsRef = useRef(controls);
  // Raw text of the "every N days" box, so it can be cleared while typing.
  const [everyDaysText, setEveryDaysText] = useState("1");

  const { connections, loading: connectionsLoading, error: connectionsError, reload } = useConnections();
  // TikTok is never offered here: it needs choices for each video.
  const offeredPlatforms = useMemo(
    () =>
      PLATFORM_ORDER.filter(
        (platform) =>
          platform !== "tiktok" && connections?.some((c) => c.platform === platform && c.connected),
      ),
    [connections],
  );
  const [deselected, setDeselected] = useState<Set<Platform>>(new Set());
  const selectedPlatforms = offeredPlatforms.filter((platform) => !deselected.has(platform));

  function updateRows(change: (rows: BulkRow[]) => BulkRow[]) {
    const next = change(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }

  function updateRow(id: string, patch: Partial<BulkRow> | ((row: BulkRow) => Partial<BulkRow>)) {
    updateRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...(typeof patch === "function" ? patch(row) : patch) } : row)),
    );
  }

  function respread(change: (rows: BulkRow[]) => BulkRow[] = (r) => r) {
    updateRows((current) => applySchedule(change(current), controlsRef.current));
  }

  async function uploadRow(id: string) {
    const file = filesRef.current.get(id);
    if (!file) return;
    updateRow(id, { upload: "working", progress: null, uploadError: null, sendError: null });
    try {
      // Same preparation as Create: HEIC -> JPEG, big photos shrunk, unsupported types refused.
      const prepared = await prepareUploadFile(file);
      filesRef.current.set(id, prepared);
      updateRow(id, { fileName: prepared.name, mimeType: prepared.type });
      let settled = false;
      const blob = await upload(generateBlobKey(prepared), prepared, {
        access: "public",
        handleUploadUrl: "/api/upload",
        onUploadProgress: (event) => {
          if (!settled) updateRow(id, { progress: event.percentage });
        },
      }).then(
        (result) => {
          settled = true;
          return result;
        },
        async (error: unknown) => {
          settled = true;
          // A full workspace storage reaches the user as its own sentence.
          throw await explainUploadFailure(error);
        },
      );
      updateRow(id, {
        upload: "done",
        progress: null,
        blob: { url: blob.url, filename: prepared.name, mimeType: prepared.type, sizeBytes: prepared.size },
      });
    } catch (error: unknown) {
      console.error("[Add many] Upload failed", error);
      updateRow(id, {
        upload: "failed",
        progress: null,
        uploadError: errorMessage(error, "The upload failed. Retry it or remove it."),
      });
    }
  }

  async function captionRow(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row?.blob) return;
    const blob = row.blob;
    updateRow(id, { captionStatus: "writing", captionError: null });
    try {
      // For a video, a few still frames let the AI see it, as on Create.
      const frames = blob.mimeType.startsWith("video/")
        ? await extractVideoFrames(filesRef.current.get(id) ?? blob.url)
        : [];
      const response = await fetch("/api/posts/auto-caption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          mimeType: blob.mimeType,
          bulk: true,
          ...(frames.length > 0 ? { frames } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as { caption?: unknown; error?: unknown } | null;
      if (!response.ok || typeof data?.caption !== "string" || !data.caption.trim()) {
        throw new Error(typeof data?.error === "string" && data.error ? data.error : "No caption came back.");
      }
      const caption = data.caption;
      updateRow(id, (current) => ({
        captionStatus: "done",
        captionOverwrite: false,
        // Never replace what the user typed meanwhile, unless they asked for a new one.
        caption: current.captionOverwrite || !current.caption.trim() ? caption : current.caption,
      }));
    } catch (error: unknown) {
      console.error("[Add many] Caption failed", error);
      updateRow(id, {
        captionStatus: "failed",
        captionOverwrite: false,
        captionError: errorMessage(error, "No caption came back."),
      });
    }
  }

  // One upload or caption at a time, in list order, until nothing is left.
  async function runWork() {
    if (workingRef.current) return;
    workingRef.current = true;
    try {
      for (;;) {
        const work = nextWork(rowsRef.current.map((r) => ({ id: r.id, upload: r.upload, caption: r.captionStatus })));
        if (!work) break;
        if (work.step === "upload") await uploadRow(work.id);
        else await captionRow(work.id);
      }
    } finally {
      workingRef.current = false;
    }
  }

  function handleFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    setFileInputKey((key) => key + 1);
    if (picked.length === 0) return;
    const { take, tooMany: over } = filesThatFit(rowsRef.current.length, picked.length);
    setTooMany(over);
    const added = picked.slice(0, take).map((file) => {
      const row = newRow(file);
      filesRef.current.set(row.id, file);
      return row;
    });
    respread((current) => [...current, ...added]);
    void runWork();
  }

  function changeControls(patch: Partial<BulkScheduleControls>) {
    const next = { ...controlsRef.current, ...patch };
    controlsRef.current = next;
    setControls(next);
    respread();
  }

  function removeRow(id: string) {
    filesRef.current.delete(id);
    setTooMany(false);
    respread((current) => current.filter((row) => row.id !== id));
  }

  function retryUpload(id: string) {
    updateRow(id, { upload: "queued", uploadError: null });
    void runWork();
  }

  function writeAgain(id: string) {
    updateRow(id, { captionStatus: "waiting", captionOverwrite: true, captionError: null });
    void runWork();
  }

  async function finish(mode: BulkFinishMode) {
    if (sendingMode) return;
    setSendingMode(mode);
    try {
      // One after another; a row that already has a post is never sent again.
      for (const id of rowsRef.current.filter((r) => r.postId === null).map((r) => r.id)) {
        const row = rowsRef.current.find((r) => r.id === id);
        if (!row || row.postId !== null) continue;
        const { platforms } = platformsForRow(selectedPlatforms, row.mimeType);
        const block = rowSendBlock(
          { id, uploaded: row.blob !== null, caption: row.caption, platforms, when: row.when, postId: row.postId },
          mode,
        );
        const scheduledFor = mode === "schedule" ? localDateTimeToUtcIso(row.when) : null;
        if (block || !row.blob || (mode === "schedule" && !scheduledFor)) {
          updateRow(id, { sendError: block ?? BULK_NO_TIME_MESSAGE });
          continue;
        }
        const body = buildUploadPostBody({
          blob: row.blob,
          baseCaption: row.caption,
          location: "",
          platforms,
          deferred: mode === "draft" ? { draft: true } : { scheduledFor: scheduledFor ?? undefined },
          workspaceId,
        });
        updateRow(id, { sending: true, sendError: null });
        try {
          const response = await fetch("/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data: unknown = await response.json().catch(() => null);
          const result = sendResultFromResponse({ ok: response.ok, body: data, mode });
          updateRow(
            id,
            result.created
              ? {
                  sending: false,
                  postId: result.postId,
                  // The post exists with this time; changing the controls must not move what is shown.
                  whenSetByHand: true,
                  result: result.heldForApproval
                    ? "Sent for approval"
                    : mode === "draft"
                      ? "Saved as a draft"
                      : "Scheduled",
                }
              : { sending: false, sendError: result.error },
          );
        } catch (error: unknown) {
          console.error("[Add many] Create failed", error);
          updateRow(id, { sending: false, sendError: NETWORK_ERROR });
        }
      }
    } finally {
      setSendingMode(null);
    }
  }

  const workState = rows.map((r) => ({ id: r.id, upload: r.upload, caption: r.captionStatus }));
  const captionProgress = captionProgressText(workState);
  const uploadsPending = rows.some((r) => r.upload === "queued" || r.upload === "working");
  const busy = uploadsPending || captionProgress !== null;
  const done = allRowsCreated(rows);
  const uploadingIndex = rows.findIndex((r) => r.upload === "working");

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-files">Photos and videos</Label>
          <Input
            key={fileInputKey}
            id="bulk-files"
            type="file"
            multiple
            accept="video/*,image/*"
            disabled={rows.length >= BULK_MAX_FILES || sendingMode !== null}
            onChange={(event) => handleFiles(event.target.files)}
            className="h-12"
          />
          <p className="text-sm text-muted-foreground">
            {rows.length} of {BULK_MAX_FILES} added.
          </p>
          {tooMany ? <Alert variant="warning">{BULK_TOO_MANY_FILES_MESSAGE}</Alert> : null}
          {uploadingIndex >= 0 ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Uploading {uploadingIndex + 1} of {rows.length}
            </p>
          ) : null}
          {captionProgress ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {captionProgress}
            </p>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">Post every row to</legend>
          {connectionsLoading && !connections ? (
            <p className="text-sm text-muted-foreground">Loading your platforms...</p>
          ) : connectionsError ? (
            <Alert variant="danger">
              {connectionsError}{" "}
              <Button variant="link" size="sm" onClick={reload}>
                Try again
              </Button>
            </Alert>
          ) : offeredPlatforms.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No platform here is connected yet.{" "}
              <Link href={SETTINGS_CONNECTIONS_HREF} className="text-primary underline-offset-4 hover:underline">
                Connect one in Settings
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {offeredPlatforms.map((platform) => (
                <label
                  key={platform}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-input px-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={!deselected.has(platform)}
                    onChange={(event) =>
                      setDeselected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(platform);
                        else next.add(platform);
                        return next;
                      })
                    }
                  />
                  {platformLabel(platform)}
                </label>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground">{BULK_TIKTOK_NOTE}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">When</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-first-day">First day</Label>
              <Input
                id="bulk-first-day"
                type="date"
                className="h-11"
                value={controls.firstDay}
                onChange={(event) => changeControls({ firstDay: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-time">Time of day</Label>
              <Input
                id="bulk-time"
                type="time"
                className="h-11"
                value={controls.timeOfDay}
                onChange={(event) => changeControls({ timeOfDay: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-every">One every N days</Label>
              <Input
                id="bulk-every"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                className="h-11"
                value={everyDaysText}
                onChange={(event) => {
                  setEveryDaysText(event.target.value);
                  changeControls({ everyDays: Number(event.target.value) });
                }}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Times are in {localTimeZoneLabel()}. A date you change by hand on a row stays as you set it.
          </p>
        </fieldset>
      </Card>

      {rows.length > 0 ? (
        <ol className="flex flex-col gap-4">
          {rows.map((row, index) => (
            <BulkPostRow
              key={row.id}
              row={row}
              index={index}
              count={rows.length}
              skipped={platformsForRow(selectedPlatforms, row.mimeType).skipped}
              locked={sendingMode !== null}
              onCaptionChange={(caption) => updateRow(row.id, { caption, sendError: null })}
              onWhenChange={(when) => updateRow(row.id, { when, whenSetByHand: true, sendError: null })}
              onMove={(delta) => respread((current) => moveRow(current, row.id, delta))}
              onRemove={() => removeRow(row.id)}
              onRetry={() => retryUpload(row.id)}
              onWriteAgain={() => writeAgain(row.id)}
            />
          ))}
        </ol>
      ) : null}

      {rows.length > 0 && !done ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={busy || sendingMode !== null || selectedPlatforms.length === 0}
            loading={sendingMode === "schedule"}
            onClick={() => void finish("schedule")}
          >
            Schedule all
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={busy || sendingMode !== null || selectedPlatforms.length === 0}
            loading={sendingMode === "draft"}
            onClick={() => void finish("draft")}
          >
            Save all as drafts
          </Button>
          {busy ? (
            <p className="self-center text-sm text-muted-foreground">
              The buttons wait until every file is uploaded and captioned.
            </p>
          ) : null}
        </div>
      ) : null}

      {done ? (
        <Alert variant="success" title="Every post is created.">
          <Link href="/queue" className={buttonVariants({ variant: "primary", size: "lg", className: "mt-2" })}>
            Open the Queue
          </Link>
        </Alert>
      ) : null}
    </div>
  );
}
