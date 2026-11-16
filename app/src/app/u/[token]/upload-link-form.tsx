"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { focusAfterPress } from "@/lib/focusAfter";
import { addPickedFiles, fileKind, splitDroppedFiles, type PickedFile } from "@/lib/clientPage";
import { UPLOAD_LINK_TEXT_MAX } from "@/lib/uploadLink";

import { ClientFileError, sendClientFile, type ClientFileFailure } from "./send-file";
import { UploadFileRow } from "./upload-file-row";

/**
 * The client's side of an upload link (2026-11-10): an optional name and note,
 * several files, progress per file, then how many arrived. Files go one at a
 * time, which suits a phone's connection and keeps the progress readable.
 */

/** Makes and frees the preview address of a photo; the row shows an icon until it exists. */
function FileRow({ item, onRemove }: { item: PickedFile; onRemove?: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isPhoto = fileKind(item.file) === "photo";
  useEffect(() => {
    if (!isPhoto) return;
    const url = URL.createObjectURL(item.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address needs the browser, so it cannot be made while rendering
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, isPhoto]);
  return <UploadFileRow item={item} previewUrl={previewUrl} onRemove={onRemove} />;
}

const NETWORK_MESSAGE = "Couldn't reach Vibe Socials. Check your connection and try again.";

/**
 * A failed file's kind and sentence, as send-file.ts set them where the
 * failure was detected. Anything else (a fetch TypeError, "Failed to fetch")
 * is a network failure in plain words.
 */
export function failureOf(error: unknown): ClientFileFailure {
  if (error instanceof ClientFileError) return { kind: error.kind, message: error.message };
  return { kind: "network", message: NETWORK_MESSAGE };
}

function nothingSentText(failures: ClientFileFailure[]): string {
  const one = failures.length === 1;
  if (failures.every((failure) => failure.kind === "network")) {
    const reason = one
      ? "The file didn't arrive. The reason is under it."
      : `None of the ${failures.length} files arrived. The reason is under each file.`;
    return `${reason} Check your connection, then try again with the button below.`;
  }
  // A refusal is not the connection's fault: say its reason when it is the only one.
  const reasons = new Set(failures.map((failure) => `${failure.kind}:${failure.message}`));
  if (reasons.size === 1) {
    return `${one ? "The file wasn't sent." : `None of the ${failures.length} files were sent.`} ${failures[0].message}`;
  }
  return "None of the files were sent. See the reason under each file.";
}

/**
 * What arrived, once every file was tried. R5-pages L9: when none arrived it is
 * an alert, so a screen reader hears it, where before the page said nothing.
 * `failures` are the failed files' kinds and sentences. R27 MM3: both regions
 * are rendered empty before the files are sent, so the result is announced
 * when it is written into them.
 */
export function UploadSummary({
  sentCount,
  failures,
  total,
}: {
  sentCount: number;
  failures: ClientFileFailure[];
  total: number;
}) {
  return (
    <>
      {/* Visually hidden while empty: no room taken, still live regions. */}
      <div role="alert" className="empty:sr-only">
        {sentCount === 0 && failures.length > 0 ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
            <p className="text-lg font-semibold">Nothing was sent</p>
            <p className="mt-1 text-sm">{nothingSentText(failures)}</p>
          </div>
        ) : null}
      </div>
      <div role="status" className="empty:sr-only">
        {sentCount > 0 ? (
          <div className="rounded-lg border border-border bg-muted p-4">
            <p className="text-lg font-semibold">Sent</p>
            <p className="mt-1 text-sm">
              {sentCount === total
                ? `${sentCount} ${sentCount === 1 ? "file" : "files"} arrived. Thank you.`
                : `${sentCount} of ${total} files arrived. The others are marked below.`}
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function UploadLinkForm({ token }: { token: string }) {
  const [senderName, setSenderName] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [phase, setPhase] = useState<"picking" | "sending" | "done">("picking");
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  // Why each failed file failed, by file key (PickedFile carries the sentence only).
  const [failureKinds, setFailureKinds] = useState<Record<string, ClientFileFailure["kind"]>>({});
  const sendRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  function update(key: string, change: Partial<PickedFile>) {
    setFiles((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (files.length === 0 || phase === "sending") return;
    // R27 MM3: "Try the files that didn't send" goes when sending starts; focus goes to Send.
    focusAfterPress((event.nativeEvent as SubmitEvent).submitter, () => sendRef.current);
    setPhase("sending");
    for (const item of files) {
      if (item.status === "sent") continue;
      update(item.key, { status: "sending", progress: 0, error: null });
      try {
        await sendClientFile({
          token,
          file: item.file,
          senderName,
          note,
          onProgress: (progress) => update(item.key, { progress }),
        });
        update(item.key, { status: "sent", progress: 100 });
      } catch (error) {
        const failure = failureOf(error);
        setFailureKinds((prev) => ({ ...prev, [item.key]: failure.kind }));
        update(item.key, { status: "failed", error: failure.message });
      }
    }
    // Send is replaced by the result: focus goes to the summary, which says it.
    focusAfterPress(sendRef.current, () => summaryRef.current);
    setPhase("done");
  }

  function startOver() {
    setFiles([]);
    setFailureKinds({});
    setPhase("picking");
  }

  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    setFiles((prev) => addPickedFiles(prev, incoming));
  }

  function removeFile(key: string) {
    setFiles((prev) => prev.filter((item) => item.key !== key));
  }

  const sentCount = files.filter((item) => item.status === "sent").length;
  const failedCount = files.filter((item) => item.status === "failed").length;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Empty until the files were tried, and then without the form's gap under it. */}
      <div ref={summaryRef} tabIndex={-1} className={cn("outline-none", phase !== "done" && "mb-0")}>
        <UploadSummary
          sentCount={phase === "done" ? sentCount : 0}
          failures={
            phase === "done"
              ? files.flatMap((item) =>
                  item.status === "failed"
                    ? [{ kind: failureKinds[item.key] ?? "network", message: item.error ?? NETWORK_MESSAGE }]
                    : [],
                )
              : []
          }
          total={files.length}
        />
      </div>

      {phase !== "done" ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="upload-link-name">Your name (optional)</Label>
            <Input
              id="upload-link-name"
              value={senderName}
              maxLength={UPLOAD_LINK_TEXT_MAX}
              autoComplete="name"
              disabled={phase === "sending"}
              className="text-base"
              onChange={(event) => setSenderName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upload-link-note">Note (optional)</Label>
            <Textarea
              id="upload-link-note"
              value={note}
              maxLength={UPLOAD_LINK_TEXT_MAX}
              rows={3}
              disabled={phase === "sending"}
              className="text-base"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium leading-none">Photos and videos</span>
            {/* The input stays a real file input, only hidden from the eye, so a
                keyboard or a screen reader reaches it; the label is the drop area. */}
            <label
              htmlFor="upload-link-files"
              onDragOver={(event) => {
                if (phase === "sending") return;
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (phase === "sending") return;
                const dropped = splitDroppedFiles(Array.from(event.dataTransfer.files));
                setDropNote(dropped.message);
                addFiles(dropped.accepted);
              }}
              className={cn(
                "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius)] border-2 border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background hover:bg-muted",
                dragging && "border-primary bg-muted",
                phase === "sending" && "pointer-events-none opacity-50",
              )}
            >
              <input
                id="upload-link-files"
                type="file"
                multiple
                accept="image/*,video/*"
                disabled={phase === "sending"}
                className="sr-only"
                onChange={(event) => {
                  // A new pick replaces an earlier drop's "left out" note.
                  setDropNote(null);
                  addFiles(Array.from(event.target.files ?? []));
                  // Emptied after each pick, so choosing the same file again still fires.
                  event.target.value = "";
                }}
              />
              <span className="text-base font-medium">Tap to choose photos and videos</span>
              <span className="text-sm text-muted-foreground">or drop them here</span>
            </label>
          </div>
        </>
      ) : null}

      {dropNote ? (
        <p role="status" className="text-sm text-muted-foreground">
          {dropNote}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="space-y-2" aria-label="Files">
          {files.map((item) => (
            <FileRow
              key={item.key}
              item={item}
              onRemove={phase === "picking" ? () => removeFile(item.key) : undefined}
            />
          ))}
        </ul>
      ) : null}

      {phase === "done" ? (
        <div className="flex flex-col gap-3">
          {failedCount > 0 ? (
            <Button type="submit" size="lg" className="w-full">
              Try the {failedCount === 1 ? "file" : `${failedCount} files`} that didn&apos;t send
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="lg" className="w-full" onClick={startOver}>
            Send more
          </Button>
        </div>
      ) : (
        <Button
          ref={sendRef}
          type="submit"
          size="lg"
          className="w-full"
          loading={phase === "sending"}
          disabled={files.length === 0}
        >
          {files.length > 1 ? `Send ${files.length} files` : "Send"}
        </Button>
      )}
    </form>
  );
}
