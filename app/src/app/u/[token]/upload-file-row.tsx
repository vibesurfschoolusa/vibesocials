import { fileKind, formatFileSize, type PickedFile } from "@/lib/clientPage";

import type { ClientFileFailureKind } from "./send-file";

/**
 * One chosen file on the upload page: a thumbnail (photos) or a film icon
 * (videos), the name, the size, and where it is: waiting, a percentage, Sent,
 * Not sent, or (R29) May have arrived. The preview address is made by the
 * caller (it needs the browser).
 */

function statusText(item: PickedFile, maybe: boolean): string {
  switch (item.status) {
    case "waiting":
      return "Waiting";
    case "sending":
      return `${Math.round(item.progress)}%`;
    case "sent":
      return "Sent";
    case "failed":
      return maybe ? "May have arrived" : "Not sent";
  }
}

function KindIcon({ kind }: { kind: "photo" | "video" }) {
  return (
    <svg
      data-kind={kind}
      aria-hidden
      viewBox="0 0 24 24"
      className="h-6 w-6 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "video" ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18M3 15h18M8 5v4M8 15v4M16 5v4M16 15v4" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m21 16-5-5-8 8" />
        </>
      )}
    </svg>
  );
}

export function UploadFileRow({
  item,
  previewUrl,
  onRemove,
  failureKind,
}: {
  item: PickedFile;
  previewUrl: string | null;
  /** Given only before sending: the file can still be taken off the list. */
  onRemove?: () => void;
  /**
   * Why a failed file failed (send-file.ts). R29 lead review: a "maybe" file
   * is not marked as not sent; a failure with no kind is read as maybe, as
   * the form reads one it can't place.
   */
  failureKind?: ClientFileFailureKind;
}) {
  const kind = fileKind(item.file);
  const progress = item.status === "failed" ? 100 : item.progress;
  const failed = item.status === "failed";
  const maybe = failed && (failureKind ?? "maybe") === "maybe";
  const notSent = failed && !maybe;
  return (
    <li className="space-y-2 rounded-[var(--radius)] border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {kind === "photo" && previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file; next/image cannot load a blob address
            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <KindIcon kind={kind} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatFileSize(item.file.size)} · <span className={notSent ? "text-destructive" : maybe ? "text-foreground" : undefined}>{statusText(item, maybe)}</span>
          </p>
        </div>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${item.file.name}`}
            className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden>×</span>
          </button>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={`${item.file.name} progress`}
        aria-valuenow={Math.round(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={
            notSent
              ? "h-full rounded-full bg-destructive"
              : maybe
                ? "h-full rounded-full bg-muted-foreground"
                : "h-full rounded-full bg-primary transition-all duration-200"
          }
          style={{ width: `${progress}%` }}
        />
      </div>
      {item.error ? <p className={maybe ? "text-sm text-foreground" : "text-sm text-destructive"}>{item.error}</p> : null}
    </li>
  );
}
