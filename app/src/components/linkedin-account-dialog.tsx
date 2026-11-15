"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LINKEDIN_CONNECT_URL,
  LINKEDIN_SIGN_OUT_URL,
  linkedInAccountDialogCopy,
  type LinkedInAccountDialogMode,
} from "@/lib/linkedinAccount";
import { withWorkspaceId } from "@/lib/workspaceChanged";

interface Props {
  /** The workspace this page was rendered for; the start route refuses any other (F3). */
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: LinkedInAccountDialogMode;
  /**
   * Runs before the connect starts (Switch account disconnects the current
   * connection). Throw to stay on the dialog; the caller reports the error.
   */
  beforeContinue?: () => Promise<void>;
  /** R6-pages L3: Switch account says what happens to scheduled posts (connection-actions.tsx). */
  scheduledNote?: string;
}

/**
 * G4 (R2-security L2): Switch account disconnects the current page first, which
 * deletes the post numbers read from it (api/connections/[platform] DELETE).
 */
export function linkedInSwitchNumbersNote(mode: LinkedInAccountDialogMode): string | null {
  return mode === "switch"
    ? "The post numbers read from this platform are deleted and cannot be brought back."
    : null;
}

/**
 * Lets the user sign out of LinkedIn before connecting, so LinkedIn asks which
 * account to use instead of silently reusing the signed-in one
 * (lib/linkedinAccount.ts).
 */
export function LinkedInAccountDialog({ workspaceId, open, onOpenChange, mode, beforeContinue, scheduledNote }: Props) {
  const [busy, setBusy] = useState(false);
  const copy = linkedInAccountDialogCopy(mode);
  const numbersNote = linkedInSwitchNumbersNote(mode);

  async function handleContinue() {
    setBusy(true);
    try {
      await beforeContinue?.();
    } catch {
      setBusy(false);
      return;
    }
    // Full-page navigation to the API route that issues the OAuth redirect.
    window.location.href = withWorkspaceId(LINKEDIN_CONNECT_URL, workspaceId);
  }

  return (
    <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange}>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          {copy.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-muted-foreground">{copy.shortcut}</p>
        {scheduledNote ? <p className="mt-3 text-sm text-muted-foreground">{scheduledNote}</p> : null}
        {numbersNote ? <p className="mt-3 text-sm text-muted-foreground">{numbersNote}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => window.open(LINKEDIN_SIGN_OUT_URL, "_blank", "noopener,noreferrer")}
          disabled={busy}
        >
          Open LinkedIn sign-out
        </Button>
        <Button onClick={handleContinue} loading={busy}>
          {copy.continueLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The Connect button for an unconnected LinkedIn row (connections-section.tsx). */
export function LinkedInConnectButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Connect
      </Button>
      <LinkedInAccountDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} mode="connect" />
    </>
  );
}
