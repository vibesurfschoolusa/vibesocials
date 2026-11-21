"use client";

import { useEffect, useState } from "react";
import type { Platform } from "@prisma/client";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/buttonVariants";
import {
  ConfirmDialog,
  ConfirmFailureShown,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { answerLostText } from "@/lib/answerLost";
import { platformLabel } from "@/lib/platforms";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { withWorkspaceId } from "@/lib/workspaceChanged";

import { LinkedInAccountDialog } from "./linkedin-account-dialog";
import { useResetOnReturnFromCache } from "./returnFromCache";

/**
 * R11 review: "November 21, 2026, 01:00 UTC", the end LinkedIn kept, in the
 * same words as the client's page (/c), so the two can't name different days.
 * UTC, not the viewer's zone: the server and the browser render the same text.
 * R12-pages L4: the "Ended" line uses it too.
 */
export function endsAtText(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const date = at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

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
   * to the sign-in with no disconnect (LinkedIn: after the sign-out steps), so
   * the post numbers stay and the save updates this connection in place.
   */
  reconnectSoon?: boolean;
  /**
   * R6 review low 3: with reconnectSoon, the end date (ISO) when it has
   * already passed: the row says it ended instead of "Ends soon".
   */
  endedAt?: string | null;
  /**
   * Team Workspaces (Task 7, design §7): connect/disconnect/switch/reconnect
   * are all owner-only mutations. A read-only (member) caller gets the same
   * health status — Connected, or a "Needs reconnect" badge in place of the
   * owner's actionable Reconnect button — with none of the buttons.
   */
  readOnly?: boolean;
  /** The connected account's name: LinkedIn's Reconnect says to sign in to it. */
  accountName?: string;
  /**
   * R8-pages L5: with reconnectSoon, the end date (ISO) a reconnect just
   * kept (Settings' same-end warning applies): the row says so instead of
   * "Ends soon".
   */
  sameEndAt?: string | null;
  /**
   * R13-pages L3: with reconnectSoon, the end date (ISO) still ahead: a
   * member's "Ends soon" row says when, as the Ended row does.
   */
  endsAt?: string | null;
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
 * scheduled posts chose it, null when that could not be read. R61 pages-a-2
 * L1: the count takes in posts waiting for approval, so the sentence names them.
 */
function scheduledPostsSentence(platform: string, chosenCount: number | null): string {
  const label = platformLabel(platform as Platform);
  if (chosenCount === null) {
    return `Scheduled posts, and posts waiting for approval, that chose ${label} will fail on it until you reconnect it.`;
  }
  if (chosenCount === 0) {
    return `No scheduled post, or post waiting for approval, chose ${label}, so none will fail on it.`;
  }
  return chosenCount === 1
    ? `1 scheduled post, or post waiting for approval, chose ${label}. It will fail on ${label} until you reconnect it.`
    : `${chosenCount} scheduled posts, or posts waiting for approval, chose ${label}. They will fail on ${label} until you reconnect it.`;
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

/**
 * R28 NN2 (pages L1): the route may have removed the connection before the
 * answer was lost or a gateway answered 5xx, so never "still connected"; a
 * Switch account then finds it gone. Say where to check.
 */
export const DISCONNECT_MAYBE_MESSAGE = answerLostText(
  "the account may already be disconnected",
  "Reload this page to see whether it is connected.",
);

/**
 * The disconnect call. Throws an Error whose message the person can act on:
 * the route's own refusal (another workspace's tab, not the owner), or ours
 * for a lost answer or a server failure, either of which may follow the
 * removal, instead of the browser's "Failed to fetch".
 */
export async function requestDisconnect(
  fetchImpl: typeof fetch,
  platform: string,
  workspaceId: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchOrNoAnswer(
      `/api/connections/${platform}`,
      { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) },
      fetchImpl,
    );
  } catch {
    throw new Error(DISCONNECT_MAYBE_MESSAGE);
  }
  if (response.ok) return;
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(response.status < 500 && data?.error ? data.error : DISCONNECT_MAYBE_MESSAGE);
}

/**
 * R6-pages L3: Switch account disconnects first, so a scheduled post that chose
 * the platform fails on it (CONNECTION_GONE) until an account is connected
 * again; once one is, it posts to that account.
 */
export function switchScheduledSentence(platform: string): string {
  const label = platformLabel(platform as Platform);
  return `Scheduled posts that chose ${label} go to the new account once you finish signing in. If you stop before then, they fail on ${label} until you connect an account again.`;
}

export function switchDescription(platform: string): string {
  return `This disconnects your current account and sends you to reconnect a different one. ${switchScheduledSentence(platform)} Your past posts stay in Activity.${numbersDeletedSentence(platform)}`;
}

export function ConnectionActions({
  platform,
  workspaceId,
  isConnected,
  needsReconnect = false,
  reconnectSoon = false,
  endedAt = null,
  readOnly = false,
  accountName,
  sameEndAt = null,
  endsAt = null,
}: Props) {
  const router = useRouter();
  const toast = useToast();

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);

  // R37 lead follow-up: Switch account and LinkedIn's Reconnect leave the
  // page with their dialog open; Back from the cache starts clean. The
  // section refreshes the server data once for every row (connections-section).
  useResetOnReturnFromCache(setSwitchOpen, false);
  useResetOnReturnFromCache(setReconnectOpen, false);

  const isTikTok = platform === "tiktok";
  const isLinkedIn = platform === "linkedin";
  // R57 pages-b L2: every row repeats these controls, so each one's name carries the platform.
  const label = platformLabel(platform as Platform);
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_MAYBE_MESSAGE);
      throw new ConfirmFailureShown("DISCONNECT_FAILED");
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_MAYBE_MESSAGE);
      throw new ConfirmFailureShown("DISCONNECT_FAILED");
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_MAYBE_MESSAGE);
      throw new ConfirmFailureShown("DISCONNECT_FAILED");
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
      toast.error(err instanceof Error ? err.message : DISCONNECT_MAYBE_MESSAGE);
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
    // R7-pages L4: a member sees the end as the owner does, without the buttons.
    // R12-pages L3: and who can reconnect a flagged one.
    if (needsReconnect) {
      return (
        <>
          <Badge variant="danger">Needs reconnect</Badge>
          <span className="basis-full text-sm text-muted-foreground">The workspace owner can reconnect it.</span>
        </>
      );
    }
    if (reconnectSoon && endedAt) {
      return (
        <span className="basis-full text-sm text-muted-foreground">
          Ended {endsAtText(endedAt)}. The workspace owner can reconnect it.
        </span>
      );
    }
    if (reconnectSoon) {
      // R13-pages L3: when, and who can reconnect it.
      const when = endsAt ? endsAtText(endsAt) : "";
      return (
        <>
          <Badge variant="warning">Ends soon</Badge>
          <span className="basis-full text-sm text-muted-foreground">
            {when ? `Ends ${when}. ` : ""}The workspace owner can reconnect it.
          </span>
        </>
      );
    }
    return <Badge variant="success">Connected</Badge>;
  }

  // R7-pages M2: LinkedIn's Reconnect opens the sign-out steps first (the
  // dialog then starts the same sign-in); other platforms go straight to it.
  function reconnectButton(variant: "destructive" | "primary" | "outline") {
    return isLinkedIn ? (
      <Button size="sm" variant={variant} aria-label={`Reconnect ${label}`} onClick={() => setReconnectOpen(true)}>
        Reconnect
      </Button>
    ) : (
      <a href={authUrl} aria-label={`Reconnect ${label}`} className={buttonVariants({ variant, size: "sm" })}>
        Reconnect
      </a>
    );
  }

  return (
    <>
      {/* R7 review 1: wraps, the Ended sentence on its own line (basis-full). */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
        {needsReconnect ? (
          // Roadmap Phase 4: destructive button to this platform's OAuth
          // start (a plain anchor: /api/auth/* is a redirect handler, not a
          // Next.js route); LinkedIn's opens the sign-out steps first.
          reconnectButton("destructive")
        ) : reconnectSoon ? (
          <>
            {endedAt ? (
              // R7-pages L7: on its own line, so the row never overflows.
              <span className="basis-full text-sm text-muted-foreground">
                Ended {endsAtText(endedAt)}. Reconnect to keep posting.
              </span>
            ) : sameEndAt ? (
              // R8-pages L5: Settings' warning says what to do; no call to reconnect here.
              <span className="basis-full text-sm text-muted-foreground">
                Ends {endsAtText(sameEndAt)}. LinkedIn kept this end date.
              </span>
            ) : (
              <Badge variant="warning">Ends soon</Badge>
            )}
            {reconnectButton(sameEndAt && !endedAt ? "outline" : "primary")}
          </>
        ) : (
          <Badge variant="success">Connected</Badge>
        )}
        <Button size="sm" variant="outline" aria-label={`Switch account ${label}`} onClick={() => setSwitchOpen(true)}>
          Switch account
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Disconnect ${label}`}
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

      {isLinkedIn && (needsReconnect || reconnectSoon) ? (
        <LinkedInAccountDialog
          open={reconnectOpen}
          onOpenChange={setReconnectOpen}
          mode="reconnect"
          accountName={accountName}
          workspaceId={workspaceId}
        />
      ) : null}

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
            <p className="mt-3 text-sm text-muted-foreground">{switchScheduledSentence(platform)}</p>
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
          scheduledNote={switchScheduledSentence(platform)}
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
