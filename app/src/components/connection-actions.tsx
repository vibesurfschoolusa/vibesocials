"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { withWorkspaceId } from "@/lib/workspaceChanged";

import { LinkedInAccountDialog } from "./linkedin-account-dialog";

interface Props {
  platform: string;
  /** The workspace this page was rendered for; the routes refuse any other (F3). */
  workspaceId: string;
  isConnected: boolean;
  /**
   * Roadmap Phase 4: true when this connection needs reconnecting (see
   * server/platforms/connectionHealth.ts). Swaps the "Connected" badge for a
   * danger "Reconnect" badge that links to this platform's OAuth start.
   */
  needsReconnect?: boolean;
  /**
   * Team Workspaces (Task 7, design §7): connect/disconnect/switch/reconnect
   * are all owner-only mutations. A read-only (member) caller gets the same
   * health status — Connected, or a "Needs reconnect" badge in place of the
   * owner's actionable Reconnect button — with none of the buttons.
   */
  readOnly?: boolean;
}

const TIKTOK_LOGOUT_URL = "https://www.tiktok.com/logout";

/**
 * G4 (R2-security L2): disconnecting deletes the post numbers read from the
 * platform; for Google Business Profile (no post numbers are read) the listing's numbers
 * (api/connections/[platform] DELETE). X and TikTok have none to delete.
 */
function numbersDeletedSentence(platform: string): string {
  if (platform === "x" || platform === "tiktok") return "";
  if (platform === "google_business_profile") {
    return " The Google listing numbers read from it are deleted and cannot be brought back.";
  }
  return " The post numbers read from this platform are deleted and cannot be brought back.";
}

export function disconnectDescription(platform: string): string {
  return `Future posts, including scheduled ones, will skip this platform. Your past posts stay in Activity, and you can reconnect at any time.${numbersDeletedSentence(platform)}`;
}

export function switchDescription(platform: string): string {
  return `This disconnects your current account and sends you to reconnect a different one. Your past posts stay in Activity.${numbersDeletedSentence(platform)}`;
}

export function ConnectionActions({
  platform,
  workspaceId,
  isConnected,
  needsReconnect = false,
  readOnly = false,
}: Props) {
  const router = useRouter();
  const toast = useToast();

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const isTikTok = platform === "tiktok";
  const isLinkedIn = platform === "linkedin";
  const authUrl = withWorkspaceId(`/api/auth/${platform}/start`, workspaceId);

  // Shared disconnect call. Throws on failure so callers can decide whether to
  // keep a dialog open (ConfirmDialog) or reset local state (TikTok flow).
  async function disconnect() {
    const response = await fetch(`/api/connections/${platform}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(data?.error ?? "Failed to disconnect.");
    }
  }

  // Disconnect: replaces the native confirm(). On error we re-throw so the
  // ConfirmDialog stays open for a retry, surfacing the reason via toast.
  async function handleDisconnect() {
    try {
      await disconnect();
    } catch (err) {
      console.error("[Disconnect] Error:", err);
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
      throw err;
    }
    toast.success(
      isLinkedIn
        ? "LinkedIn disconnected. Connect asks you to sign out of LinkedIn first if you want a different account."
        : "Account disconnected.",
    );
    router.refresh();
  }

  // LinkedIn switch: disconnect, then connect again after the user has had the
  // chance to sign out of linkedin.com (LinkedInAccountDialog). Throws to keep
  // the dialog open when the disconnect fails.
  async function disconnectForLinkedInSwitch() {
    try {
      await disconnect();
    } catch (err) {
      console.error("[Switch Account] Error:", err);
      toast.error(err instanceof Error ? err.message : "Failed to disconnect current account.");
      throw err;
    }
  }

  // Standard switch: disconnect the current account, then redirect to the
  // platform's OAuth start so a different account can be connected. Same flow as
  // before, minus the native confirm().
  async function handleStandardSwitch() {
    try {
      await disconnect();
    } catch (err) {
      console.error("[Switch Account] Error:", err);
      toast.error(err instanceof Error ? err.message : "Failed to disconnect current account.");
      throw err;
    }
    window.location.href = authUrl;
  }

  // TikTok switch: TikTok keeps the user signed in, so switching means
  // disconnecting here, then logging out of tiktok.com in a new tab before
  // reconnecting. Same underlying behavior as the old confirm()/window.open()/
  // setTimeout()/alert() chain, now presented in an accessible dialog.
  async function handleTikTokSwitch() {
    setSwitching(true);
    try {
      await disconnect();
    } catch (err) {
      console.error("[Switch Account] Error:", err);
      toast.error(err instanceof Error ? err.message : "Unexpected error.");
      setSwitching(false);
      return;
    }
    window.open(TIKTOK_LOGOUT_URL, "_blank", "noopener,noreferrer");
    setSwitching(false);
    setSwitchOpen(false);
    toast.success("TikTok disconnected. Log out in the new tab, then click Connect.");
    router.refresh();
  }

  if (!isConnected) {
    return null;
  }

  if (readOnly) {
    return needsReconnect ? (
      <Badge variant="danger">Needs reconnect</Badge>
    ) : (
      <Badge variant="success">Connected</Badge>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {needsReconnect ? (
          // Roadmap Phase 4: destructive button, links straight to this
          // platform's OAuth start (a plain anchor — /api/auth/* is a
          // redirect handler, not a Next.js route, matching the "Connect"
          // ButtonLink below).
          <a href={authUrl} className={buttonVariants({ variant: "destructive", size: "sm" })}>
            Reconnect
          </a>
        ) : (
          <Badge variant="success">Connected</Badge>
        )}
        <Button size="sm" variant="outline" onClick={() => setSwitchOpen(true)}>
          Switch account
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setDisconnectOpen(true)}
        >
          Disconnect
        </Button>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        destructive
        title="Disconnect this account?"
        description={disconnectDescription(platform)}
        confirmText="Disconnect"
        onConfirm={handleDisconnect}
      />

      {isTikTok ? (
        <Dialog
          open={switchOpen}
          onOpenChange={switching ? () => undefined : setSwitchOpen}
        >
          <DialogHeader>
            <DialogTitle>Switch TikTok account</DialogTitle>
            <DialogDescription>
              TikTok keeps you signed in, so switching accounts takes a few manual steps.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>We disconnect this account and open TikTok logout in a new tab.</li>
              <li>Log out of your current TikTok account in that tab.</li>
              <li>
                Come back here and click{" "}
                <span className="font-medium text-foreground">Connect</span>.
              </li>
              <li>Sign in with your private TikTok account.</li>
            </ol>
            <p className="mt-3 text-sm text-muted-foreground">
              Your account must be set to{" "}
              <span className="font-medium text-foreground">Private</span> in TikTok
              settings.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwitchOpen(false)} disabled={switching}>
              Cancel
            </Button>
            <Button onClick={handleTikTokSwitch} loading={switching}>
              Disconnect &amp; open TikTok logout
            </Button>
          </DialogFooter>
        </Dialog>
      ) : isLinkedIn ? (
        <LinkedInAccountDialog
          open={switchOpen}
          onOpenChange={setSwitchOpen}
          mode="switch"
          beforeContinue={disconnectForLinkedInSwitch}
          workspaceId={workspaceId}
        />
      ) : (
        <ConfirmDialog
          open={switchOpen}
          onOpenChange={setSwitchOpen}
          title="Switch account?"
          description={switchDescription(platform)}
          confirmText="Continue"
          onConfirm={handleStandardSwitch}
        />
      )}
    </>
  );
}
