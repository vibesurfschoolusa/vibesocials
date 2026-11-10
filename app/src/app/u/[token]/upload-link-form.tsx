"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UPLOAD_LINK_TEXT_MAX } from "@/lib/uploadLink";

import { sendClientFile } from "./send-file";

/**
 * The client's side of an upload link (2026-11-10): an optional name and note,
 * several files, progress per file, then how many arrived. Files go one at a
 * time, which suits a phone's connection and keeps the progress readable.
 */

type FileStatus = "waiting" | "sending" | "sent" | "failed";

interface PickedFile {
  key: string;
  file: File;
  status: FileStatus;
  progress: number;
  error: string | null;
}

function statusText(item: PickedFile): string {
  switch (item.status) {
    case "waiting":
      return "Waiting";
    case "sending":
      return `${Math.round(item.progress)}%`;
    case "sent":
      return "Sent";
    case "failed":
      return "Not sent";
  }
}

export function UploadLinkForm({ token }: { token: string }) {
  const [senderName, setSenderName] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [phase, setPhase] = useState<"picking" | "sending" | "done">("picking");
  const [inputKey, setInputKey] = useState(0);

  function update(key: string, change: Partial<PickedFile>) {
    setFiles((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (files.length === 0 || phase === "sending") return;
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
        update(item.key, {
          status: "failed",
          error: error instanceof Error ? error.message : "Couldn't send this file. Try again.",
        });
      }
    }
    setPhase("done");
  }

  function startOver() {
    setFiles([]);
    setPhase("picking");
    setInputKey((key) => key + 1);
  }

  const sentCount = files.filter((item) => item.status === "sent").length;
  const failedCount = files.filter((item) => item.status === "failed").length;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {phase === "done" && sentCount > 0 ? (
        <div role="status" className="rounded-lg border border-border bg-muted p-4">
          <p className="text-lg font-semibold">Sent</p>
          <p className="mt-1 text-sm">
            {sentCount === files.length
              ? `${sentCount} ${sentCount === 1 ? "file" : "files"} arrived. Thank you.`
              : `${sentCount} of ${files.length} files arrived. The others are marked below.`}
          </p>
        </div>
      ) : null}

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
            <Label htmlFor="upload-link-files">Photos and videos</Label>
            <Input
              key={inputKey}
              id="upload-link-files"
              type="file"
              multiple
              accept="image/*,video/*"
              disabled={phase === "sending"}
              className="cursor-pointer text-base"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                setFiles(
                  picked.map((file, index) => ({
                    key: `${index}-${file.name}-${file.size}-${file.lastModified}`,
                    file,
                    status: "waiting",
                    progress: 0,
                    error: null,
                  })),
                );
              }}
            />
          </div>
        </>
      ) : null}

      {files.length > 0 ? (
        <ul className="space-y-3" aria-label="Files">
          {files.map((item) => (
            <li key={item.key} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="flex-shrink-0 text-muted-foreground">{statusText(item)}</span>
              </div>
              <div
                role="progressbar"
                aria-label={`${item.file.name} progress`}
                aria-valuenow={Math.round(item.progress)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={
                    item.status === "failed"
                      ? "h-full rounded-full bg-destructive"
                      : "h-full rounded-full bg-primary transition-all duration-200"
                  }
                  style={{ width: `${item.status === "failed" ? 100 : item.progress}%` }}
                />
              </div>
              {item.error ? <p className="text-sm text-destructive">{item.error}</p> : null}
            </li>
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
