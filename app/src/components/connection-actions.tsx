"use client";

import { useEffect, useState } from "react";
import type { Platform } from "@prisma/client";
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
import { platformLabel } from "@/lib/platforms";
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
   * R6-pages M1: true inside the warning window (lib/connectionExpiry.ts): it
   * still works, but cannot be renewed and ends within a week. Shows Reconnect,
   * straight to the sign-in with no disconnect, so the post numbers stay and
   * the save updates this connection in place.
   */
  reconnectSoon?: boolean;
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

/**
 * R5 pages M1: a scheduled post that chose this platform does not skip it:
 * at publish time it gets a failed "not connected" result on it
 * (server/jobs/posting.ts CONNECTION_GONE). `chosenCount` is how many
 * scheduled posts chose it, null when that could not be read.
 */
function scheduledPostsSentence(platform: string, chosenCount: number | null): string {
  const label = platformLabel(platform as Platform);
  if (chosenCount === null) {
    return `Scheduled posts that chose ${label} will fail on it until you reconnect it.`;
  }
  if (chosenCount === 0) {
    return `No scheduled post chose ${label}, so none will fail on it.`;
  }
  return chosenCount === 1
    ? `1 scheduled post chose ${label}. It will fail on ${label} until you reconnect it.`
    : `${chosenCount} scheduled posts chose ${label}. They will fail on ${label} until you reconnect it.`;
}

export function disconnectDescription(platform: string, chosenCount: number | null): string {
  return `${scheduledPostsSentence(platform, chosenCount)} Your past posts stay in Activity, and you can reconnect at any time.${numbersDeletedSentence(platform)}`;
}

/**
 * How many scheduled posts chose `platform`, counted by the server
 * (api/connections/[platform]/scheduled-count) for the workspace this page was
 * rendered for. Null when it can't be read, so the dialog still warns, without
 * a number.
 */
export async function fetchScheduledCount(
  platform: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const response = await fetchImpl(
      `/api/connections/${platform}/scheduled-count?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { count?: unknown };
    return typeof data.count === "number" ? data.count : null;
  } catch {
    return null;
  }
}

export const DISCONNECT_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so the account is still connected. Check your internet connection and try again.";
export const DISCONNECT_FAILED_MESSAGE =
  "The account couldn't be disconnected and is still connected. Please try again in a minute.";

/**
 * The disconnect call. Throws an Error whose message the person can act on:
 * the route's own refusal (another workspace's tab, not the owner), or ours
 * for a network or server failure instead of the browser's "Failed to fetch".
 */
export async function requestDisconnect(
  fetchImpl: typeof fetch,
  platform: string,
  workspaceId: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/connections/${platform}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
  } catch {
    throw new Error(DISCONNECT_OFFLINE_MESSAGE);
  }
  if (response.ok) return;
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(response.status < 500 && data?.error ? data.error : DISCONNECT_FAILED_MESSAGE);
}

export function switchDescription(platform: string): string {
  return `This disconnects your current account and sends you to reconnect a different one. Your past posts stay in Activity.${numbersDeletedSentence(platform)}`;
}

export function ConnectionActions({
  platform,
  workspaceId,
  isConnected,
  needsReconnect = false,
  reconnectSoon = false,
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

  // Read each time the Disconnect dialog opens, from no number, so it never
  // shows an earlier count while the new one loads or after it fails.
  const [chosenCount, setChosenCount] = useState<number | null>(null);
  function openDisconnect() {
    setChosenCount(null);
    setDisconnectOpen(true);
  }
  useEffect(() => {
    if (!disconnectOpen) return;
    let cancelled = false;
    void fetchScheduledCount(platform, workspaceId).then((count) => {
      if (!cancelled) setChosenCount(count);
    });
    return () => {
      cancelled = true;
    };
  }, [disconnectOpen, platform, workspaceId]);

  // Shared disconnect call. Throws on failure so callers can decide whether to
  // keep a dialog open (ConfirmDialog) or reset local state (TikTok flow).
  function disconnect() {
    return requestDisconnect(fetch, platform, workspaceId);
  }

  // Disconnect: replaces the native confirm(). On error we re-throw so the
  // ConfirmDialog stays open for a retry, surfacing the reason via toast.
  async function handleDisconnect() {
    try {
      await disconnect();
    } catch (err) {
      console.error("[Disconnect] Error:", err);
      toast.error(err instanceof Error ? err.message : DISCONNECT_FAILED_MESSAGE);
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_FAILED_MESSAGE);
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_FAILED_MESSAGE);
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_FAILED_MESSAGE);
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
        ) : reconnectSoon ? (
          <>
            <Badge variant="warning">Ends soon</Badge>
            <a href={authUrl} className={buttonVariants({ size: "sm" })}>
              Reconnect
            </a>
          </>
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
          onClick={openDisconnect}
        >
          Disconnect
        </Button>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        destructive
        title="Disconnect this account?"
        description={disconnectDescription(platform, chosenCount)}
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
