"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  LOGO_HELP_LINE,
  LOGO_SIZE_LINE,
  LOGO_MAX_BYTES,
  LOGO_REMOVE_FAILED_MESSAGE,
  LOGO_SAVE_FAILED_MESSAGE,
  LOGO_TOO_LARGE_MESSAGE,
  logoEndpoint,
} from "@/lib/workspaceLogo";

/**
 * The workspace's report logo in Settings (18b). An owner uploads, replaces
 * and removes it through /api/workspaces/logo; a member only sees it.
 */
export function WorkspaceLogoControl({
  logoUrl,
  isOwner,
  workspaceId,
  planNote,
}: {
  logoUrl: string | null;
  isOwner: boolean;
  /** The workspace this page was rendered for, so a switch in another tab is refused. */
  workspaceId: string;
  /** P1 fix round 2: set where the plan does not show the logo on the report. */
  planNote?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(logoUrl);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "POST" | "DELETE", file?: File) {
    setBusy(method === "POST" ? "upload" : "remove");
    setError(null);
    const fallback = method === "POST" ? LOGO_SAVE_FAILED_MESSAGE : LOGO_REMOVE_FAILED_MESSAGE;
    try {
      const response = await fetch(logoEndpoint(workspaceId), {
        method,
        ...(file ? { body: file, headers: { "Content-Type": file.type || "application/octet-stream" } } : {}),
      });
      const data = (await response.json().catch(() => null)) as { logoUrl?: string | null; error?: string } | null;
      if (!response.ok || !data || data.logoUrl === undefined) {
        setError(data?.error ?? fallback);
        return;
      }
      setCurrent(data.logoUrl);
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      setBusy(null);
    }
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      setError(LOGO_TOO_LARGE_MESSAGE);
      return;
    }
    void send("POST", file);
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">Logo</h3>
      <div className="flex flex-wrap items-center gap-3">
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- the logo's public storage address, as media-thumb.tsx
          <img src={current} alt="Workspace logo" className="max-h-12 w-auto max-w-[12rem] object-contain" />
        ) : (
          <p className="text-sm text-muted-foreground">No logo yet.</p>
        )}
        {isOwner ? (
          <>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={onFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={busy === "upload"}
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              Upload
            </Button>
            {current ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={busy === "remove"}
                disabled={busy !== null}
                onClick={() => void send("DELETE")}
              >
                Remove
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {/* P1 fix round 2: where the plan hides the logo, the size rule and then when it shows. */}
      {isOwner ? (
        <p className="text-sm text-muted-foreground">{planNote ? `${LOGO_SIZE_LINE} ${planNote}` : LOGO_HELP_LINE}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
