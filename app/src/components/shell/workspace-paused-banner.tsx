"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * The one banner a paused workspace's members see on every signed-in page
 * (2026-11-10), and (21a, billing on) a workspace whose trial or plan ended.
 * Asks GET /api/workspaces/status on each page change, so a pause or resume
 * shows on the next navigation; renders nothing unless the workspace is
 * blocked, or while the answer is loading or failed. In the last 3 days of a
 * trial, owners get a quieter line instead. 23: with billing on, a person whose
 * email address is not confirmed gets the routes' sentence and a button that
 * sends the link again.
 */
export function WorkspacePausedBanner({
  onConfirmEmailShownChange,
}: {
  /** Tells the shell when the confirm-your-address line is up, so it can hide the older nudge. */
  onConfirmEmailShownChange?: (shown: boolean) => void;
} = {}) {
  const { status } = useSession();
  const pathname = usePathname();
  const { success, error } = useToast();
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>(NO_STATUS);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workspaces/status", { cache: "no-store" });
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (cancelled) return;
        setWorkspaceStatus(readWorkspaceStatus(data));
      } catch {
        // Best effort: the routes still refuse with the same message.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, pathname]);

  const confirmShown = confirmEmailBannerShown(workspaceStatus);
  useEffect(() => {
    onConfirmEmailShownChange?.(confirmShown);
  }, [confirmShown, onConfirmEmailShownChange]);

  async function handleResend() {
    setSending(true);
    try {
      // The existing route, with its own per-person limit of 3 in 15 minutes.
      const response = await fetch("/api/auth/resend-verification", { method: "POST" });
      if (response.ok) {
        success("We sent a new link. Open it from your inbox to start posting.");
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        error(data?.error ?? "Could not send the link. Try again in a minute.");
      }
    } catch {
      error("Could not send the link. Try again in a minute.");
    } finally {
      setSending(false);
    }
  }

  return <WorkspaceStatusAlert status={workspaceStatus} sending={sending} onResend={handleResend} />;
}

export type WorkspaceStatus = { message: string | null; notice: string | null; emailUnconfirmed: boolean };

const NO_STATUS: WorkspaceStatus = { message: null, notice: null, emailUnconfirmed: false };

/** GET /api/workspaces/status's answer, keeping only fields of the right type. */
export function readWorkspaceStatus(data: unknown): WorkspaceStatus {
  const body = (data ?? {}) as { blockedMessage?: unknown; trialNotice?: unknown; emailUnconfirmed?: unknown };
  const message = typeof body.blockedMessage === "string" ? body.blockedMessage : null;
  return {
    message,
    notice: typeof body.trialNotice === "string" ? body.trialNotice : null,
    emailUnconfirmed: message !== null && body.emailUnconfirmed === true,
  };
}

/** Whether the banner shows the confirm-your-address line (billing on only). */
export function confirmEmailBannerShown(status: WorkspaceStatus): boolean {
  return status.emailUnconfirmed;
}

export function WorkspaceStatusAlert({
  status,
  sending,
  onResend,
}: {
  status: WorkspaceStatus;
  sending: boolean;
  onResend: () => void;
}) {
  const { message, notice, emailUnconfirmed } = status;

  if (!message && notice) {
    return (
      <div className="px-4 pt-4 md:px-6">
        <Alert variant="info" className="p-3">
          <span className="text-foreground">{notice}</span>
        </Alert>
      </div>
    );
  }

  if (!message) return null;

  if (emailUnconfirmed) {
    return (
      <div className="px-4 pt-4 md:px-6">
        <Alert variant="warning" className="items-center p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-foreground">{message}</span>
            <Button size="sm" variant="outline" loading={sending} onClick={onResend}>
              Send the link again
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="danger" className="p-3">
        <span className="text-foreground">{message}</span>
      </Alert>
    </div>
  );
}
