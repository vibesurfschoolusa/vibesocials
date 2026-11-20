"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CharacterCount, refuseOverLimit } from "@/components/ui/character-count";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { focusAfterPress } from "@/lib/focusAfter";
import { addPickedFiles, fileKind, splitDroppedFiles, type PickedFile } from "@/lib/clientPage";
import { UPLOAD_LINK_TEXT_MAX } from "@/lib/uploadLink";

import { ClientFileError, sendClientFile, type ClientFileFailure, type ClientFileFailureKind } from "./send-file";
import { UploadFileRow } from "./upload-file-row";

/**
 * The client's side of an upload link (2026-11-10): an optional name and note,
 * several files, progress per file, then how many arrived. Files go one at a
 * time, which suits a phone's connection and keeps the progress readable.
 */

/** Makes and frees the preview address of a photo; the row shows an icon until it exists. */
function FileRow({
  item,
  onRemove,
  failureKind,
}: {
  item: PickedFile;
  onRemove?: () => void;
  failureKind?: ClientFileFailureKind;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isPhoto = fileKind(item.file) === "photo";
  useEffect(() => {
    if (!isPhoto) return;
    const url = URL.createObjectURL(item.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address needs the browser, so it cannot be made while rendering
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, isPhoto]);
  return <UploadFileRow item={item} previewUrl={previewUrl} onRemove={onRemove} failureKind={failureKind} />;
}

/**
 * Lead review 3 (R28 NN2): not a lost answer (send-file.ts words those); the
 * file may still have arrived. R29 client-journey L1: so its kind is "maybe".
 */
const UNKNOWN_FAILURE_MESSAGE =
  "Something went wrong while sending this file. It may have arrived: if you send it again, it may arrive twice.";

/**
 * A failed file's kind and sentence, as send-file.ts set them where the
 * failure was detected. Anything else (a fetch TypeError, "Failed to fetch")
 * came from an unknown step, so the file may have arrived.
 */
export function failureOf(error: unknown): ClientFileFailure {
  if (error instanceof ClientFileError) return { kind: error.kind, message: error.message };
  return { kind: "maybe", message: UNKNOWN_FAILURE_MESSAGE };
}

/** A failed file as the summary names it. */
export type SummaryFailure = ClientFileFailure & { name: string };

type FileState = Pick<PickedFile, "key" | "status">;
type Kinds = Partial<Record<string, ClientFileFailureKind>>;

/**
 * R47 client-journey L1: a file refused for itself (send-file.ts's "file") is
 * refused again as it is, so no press sends it; Send more starts over.
 */
function canResend(item: FileState, kinds: Kinds): boolean {
  return item.status !== "failed" || kinds[item.key] !== "file";
}

/**
 * R29 client-journey L1: the files the next press sends. Every file not yet
 * sent, except one that may have arrived; those go only when nothing else is
 * left, from the button that warns first (retryOffer).
 */
export function filesToSend(files: FileState[], kinds: Kinds): string[] {
  const unsent = files.filter((item) => item.status !== "sent" && canResend(item, kinds));
  const sure = unsent.filter((item) => item.status !== "failed" || kinds[item.key] !== "maybe");
  return (sure.length > 0 ? sure : unsent).map((item) => item.key);
}

/** The retry button after a send, and the warning shown with it; null when nothing is left to send. */
export function retryOffer(files: FileState[], kinds: Kinds): { label: string; warning: string | null } | null {
  const failed = files.filter((item) => item.status === "failed" && canResend(item, kinds));
  if (failed.length === 0) return null;
  const sure = failed.filter((item) => kinds[item.key] !== "maybe");
  if (sure.length > 0) {
    return { label: `Try the ${sure.length === 1 ? "file" : `${sure.length} files`} that didn't send`, warning: null };
  }
  return failed.length === 1
    ? { label: "Send the file again anyway", warning: "It may already have arrived: sending it again may make a second copy." }
    : {
        label: `Send the ${failed.length} files again anyway`,
        warning: "They may already have arrived: sending them again may make second copies.",
      };
}

/**
 * R29 pages L2: the control the press's focus watch looks after. Enter in the
 * name or note field submits with Send as the submitter, and the field is
 * disabled at once, so the focused control in the form is watched; otherwise
 * the submitter. Null for Send itself: it stays (loading), and the watch at
 * the end of sending covers it.
 */
export function pressWatchTarget(
  active: Element | null,
  submitter: HTMLElement | null,
  form: Pick<HTMLElement, "contains">,
  send: HTMLElement | null,
): HTMLElement | null {
  const focused = active && active !== send && form.contains(active) ? (active as HTMLElement) : null;
  const pressed = focused ?? submitter;
  return pressed && pressed !== send ? pressed : null;
}

function nameList(failures: SummaryFailure[]): string {
  return failures.map((failure) => failure.name).join(", ");
}

/** R29 client-journey L1: which files may have arrived, and which didn't (the retry tries only those). */
function uncertainText(failures: SummaryFailure[]): string {
  const maybe = failures.filter((failure) => failure.kind === "maybe");
  const unsent = failures.filter((failure) => failure.kind !== "maybe");
  const retried = unsent.filter((failure) => failure.kind !== "file");
  const one = maybe.length === 1;
  const parts = [
    `${nameList(maybe)} may have arrived, but this page couldn't confirm ${one ? "it" : "them"}. If you send ${one ? "it" : "them"} again, ${one ? "it" : "they"} may arrive twice.`,
  ];
  if (unsent.length > 0) {
    parts.push(`${nameList(unsent)} didn't arrive: the reason is under ${unsent.length === 1 ? "it" : "each file"}.`);
    if (retried.length > 0) parts.push(`The button below tries only ${nameList(retried)} again.`);
  }
  return parts.join(" ");
}

function nothingSentText(failures: ClientFileFailure[]): string {
  const one = failures.length === 1;
  if (failures.every((failure) => failure.kind === "network")) {
    const reason = one
      ? "The file didn't arrive. The reason is under it."
      : `None of the ${failures.length} files arrived. The reason is under each file.`;
    return `${reason} Check your connection, then try again with the button below.`;
  }
  // A refusal is not the connection's fault: one file's reason is said here.
  // R49 client-journey L1: with several, each row keeps its own sentence, since
  // a sentence written for one file ("this photo… choose it again") read as
  // one file to fix when it summed up several.
  if (one) return `The file wasn't sent. ${failures[0].message}`;
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
  failures: SummaryFailure[];
  total: number;
}) {
  const maybeCount = failures.filter((failure) => failure.kind === "maybe").length;
  return (
    <>
      {/* Visually hidden while empty: no room taken, still live regions. */}
      <div role="alert" className="empty:sr-only">
        {sentCount === 0 && failures.length > 0 ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
            {maybeCount === 0 ? (
              <>
                <p className="text-lg font-semibold">Nothing was sent</p>
                <p className="mt-1 text-sm">{nothingSentText(failures)}</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold">
                  {maybeCount < failures.length
                    ? "Some files may have arrived"
                    : maybeCount === 1
                      ? "The file may have arrived"
                      : "The files may have arrived"}
                </p>
                <p className="mt-1 text-sm">{uncertainText(failures)}</p>
              </>
            )}
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
                : maybeCount > 0
                  ? `${sentCount} of ${total} files arrived. ${uncertainText(failures)}`
                  : `${sentCount} of ${total} files arrived. The others are marked below.`}
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * R45 pages-a L3: counted as the route stores them (cleanSenderText): trimmed,
 * in whole characters, a name on one line. The route would cut anything
 * longer, so Send is refused instead, with these sentences.
 */
function storedNoteLength(text: string): number {
  return Array.from(text.trim()).length;
}
function storedNameLength(text: string): number {
  return storedNoteLength(text.replace(/[\s\p{Cc}]+/gu, " "));
}
export const UPLOAD_NAME_TOO_LONG_TEXT = `Your name can be up to ${UPLOAD_LINK_TEXT_MAX} characters. Shorten it, then press Send again.`;
export const UPLOAD_NOTE_TOO_LONG_TEXT = `The note can be up to ${UPLOAD_LINK_TEXT_MAX} characters. Shorten it, then press Send again.`;

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
  const nameRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // A refused Send's sentence, until the name or note is edited.
  const [textRefusal, setTextRefusal] = useState<string | null>(null);

  function update(key: string, change: Partial<PickedFile>) {
    setFiles((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (files.length === 0 || phase === "sending") return;
    const refused = refuseOverLimit(
      [
        {
          text: senderName,
          max: UPLOAD_LINK_TEXT_MAX,
          count: storedNameLength,
          sentence: UPLOAD_NAME_TOO_LONG_TEXT,
          field: nameRef.current,
        },
        { text: note, max: UPLOAD_LINK_TEXT_MAX, count: storedNoteLength, sentence: UPLOAD_NOTE_TOO_LONG_TEXT, field: noteRef.current },
      ],
      setTextRefusal,
    );
    if (refused) return;
    // R27 MM3: "Try the files that didn't send" goes when sending starts; focus goes to Send.
    // Send itself stays (loading), and the watch at the end covers it: one watch at a time.
    // R29 pages L2: a name or note field that had focus is disabled now, so it is the one watched.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const watched = pressWatchTarget(document.activeElement, submitter, event.currentTarget, sendRef.current);
    const stopPressWatch = watched ? focusAfterPress(watched, () => sendRef.current) : () => {};
    setPhase("sending");
    const sending = new Set(filesToSend(files, failureKinds));
    for (const item of files) {
      if (!sending.has(item.key)) continue;
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
    // Lead review: a fast failure can end here before the press-time watch ran;
    // it would land on its fallback and end this one, so it stops first.
    stopPressWatch();
    focusAfterPress(sendRef.current, () => summaryRef.current);
    setPhase("done");
  }

  /** `pressed`: Send more, which the form replaces; focus goes to its first field. */
  function startOver(pressed: HTMLElement | null) {
    focusAfterPress(pressed, () => nameRef.current);
    setFiles([]);
    setFailureKinds({});
    // R30 client-journey L4: the old "left out" note goes with the old files.
    setDropNote(null);
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
  const retry = retryOffer(files, failureKinds);

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
                    ? [
                        {
                          name: item.file.name,
                          kind: failureKinds[item.key] ?? "maybe",
                          message: item.error ?? UNKNOWN_FAILURE_MESSAGE,
                        },
                      ]
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
              ref={nameRef}
              id="upload-link-name"
              value={senderName}
              autoComplete="name"
              disabled={phase === "sending"}
              className="text-base"
              aria-describedby="upload-link-name-count"
              onChange={(event) => {
                setTextRefusal(null);
                setSenderName(event.target.value);
              }}
            />
            <CharacterCount
              id="upload-link-name-count"
              label="Your name"
              text={senderName}
              max={UPLOAD_LINK_TEXT_MAX}
              count={storedNameLength}
              action="send"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upload-link-note">Note (optional)</Label>
            <Textarea
              ref={noteRef}
              id="upload-link-note"
              value={note}
              rows={3}
              disabled={phase === "sending"}
              className="text-base"
              aria-describedby="upload-link-note-count"
              onChange={(event) => {
                setTextRefusal(null);
                setNote(event.target.value);
              }}
            />
            <CharacterCount
              id="upload-link-note-count"
              label="Note"
              text={note}
              max={UPLOAD_LINK_TEXT_MAX}
              count={storedNoteLength}
              action="send"
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

      {/* R29 client-journey L5: on the page from the first render; only its text changes. */}
      <p role="status" className="empty:sr-only text-sm text-muted-foreground">
        {dropNote}
      </p>
      {files.length > 0 ? (
        <ul className="space-y-2" aria-label="Files">
          {files.map((item) => (
            <FileRow
              key={item.key}
              item={item}
              onRemove={phase === "picking" ? () => removeFile(item.key) : undefined}
              failureKind={failureKinds[item.key]}
            />
          ))}
        </ul>
      ) : null}

      {/* On the page from the first render, so a refused Send is read out. */}
      <p role="alert" className="empty:sr-only text-sm text-destructive">
        {textRefusal}
      </p>
      {phase === "done" ? (
        <div className="flex flex-col gap-3">
          {retry?.warning ? (
            <p id="upload-link-retry-warning" className="text-sm">
              {retry.warning}
            </p>
          ) : null}
          {retry ? (
            <Button
              type="submit"
              size="lg"
              className="w-full"
              aria-describedby={retry.warning ? "upload-link-retry-warning" : undefined}
            >
              {retry.label}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="lg" className="w-full" onClick={(event) => startOver(event.currentTarget)}>
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
