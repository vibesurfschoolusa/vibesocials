"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectedSuccessQuery } from "@/lib/differentAccount";
import { useRouter, useSearchParams } from "next/navigation";

import { answerLostText } from "@/lib/answerLost";
import { choiceAddress, rememberChoicePlatform, rememberedChoicePlatform } from "@/lib/choicePlatform";
import { cn } from "@/lib/cn";
import { focusAfterPress } from "@/lib/focusAfter";
import { cancelFailedText } from "@/lib/pendingChoiceText";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { withWorkspaceId } from "@/lib/workspaceChanged";
import { useResetOnReturnFromCache } from "@/components/returnFromCache";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

/** The platforms whose connect can end in a choice (server/connections/pendingConnection.ts). */
type ChoosablePlatform = "facebook_page" | "instagram" | "linkedin" | "pinterest";

/** GET /api/connections/pending/[id] candidate: ids and names only, never tokens. */
interface Candidate {
  id: string;
  name: string;
  detail?: string;
}

const COPY: Record<ChoosablePlatform, { title: string; description: string }> = {
  facebook_page: {
    title: "Choose which Facebook Page to connect",
    description: "You manage several Facebook Pages. Choose the one this workspace posts to.",
  },
  instagram: {
    title: "Choose which Instagram account to connect",
    description:
      "Several Instagram accounts are linked to your Facebook Pages. Choose the one this workspace posts to.",
  },
  linkedin: {
    title: "Choose which LinkedIn page to connect",
    description:
      "You administer several LinkedIn company pages. Choose the one this workspace posts to.",
  },
  pinterest: {
    title: "Choose which Pinterest board to post to",
    description:
      "Every Pin goes on a board. Choose the board this workspace posts to. To change it later, switch the account in Settings and choose again.",
  },
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; platform: ChoosablePlatform; candidates: Candidate[] }
  | { status: "expired"; message: string }
  | { status: "error"; message: string };

const noSubscription = () => () => {};

/** R5 pages L8: what the dialog says when Connect didn't work. */
export const PENDING_CONNECT_FAILED = "That account wasn't connected. Please press Connect again in a minute.";
/**
 * R28 NN2 (new-customer L2): the choice may have been saved before the answer
 * was lost or a gateway answered 5xx, and Connect again would then say the
 * choice expired. Cancel leaves for the connections list, where it shows.
 */
export const PENDING_CONNECT_MAYBE = answerLostText(
  "the account may have been connected",
  "Press Cancel, then look for it in your connections before you connect again.",
);

/**
 * R29 (as /c): a gone choice shows the route's sentence, which follows the
 * row Settings shows; without one, a sentence that names no button.
 */
export function pendingGoneText(data: { error?: unknown } | null): string {
  return typeof data?.error === "string" && data.error
    ? data.error
    : "This choice has ended: it expired, or an account was already chosen. Close this to see your connections.";
}

/**
 * R31 follow-up: a load that failed. Closing would cancel the choice, so the
 * step is a reload (the same choice is read again); the route may add its
 * card's button.
 */
export function pendingLoadFailedText(data: { error?: unknown } | null): string {
  return typeof data?.error === "string" && data.error ? data.error : "Couldn't load your accounts. Reload the page to try again.";
}

/**
 * R42 review: Cancel's answer. One that worked, or a choice already gone,
 * leaves for the connections list; any other answer means the choice still
 * waits, so the dialog stays and says so: the route's sentence, else ours,
 * naming the platform with the expiry unknown.
 */
export function pendingCancelOutcome(
  status: number,
  data: { error?: unknown } | null,
  platform: ChoosablePlatform | null,
): { leave: true } | { error: string } {
  if ((status >= 200 && status < 300) || status === 404) return { leave: true };
  if (typeof data?.error === "string" && data.error) return { error: data.error };
  return { error: cancelFailedText("settings", null, platform ? PLATFORM_LABELS[platform] : null) };
}

/** What a refused or unreadable Connect answer says. */
export function pendingConnectFailureText(status: number, data: { error?: string } | null): string {
  if (typeof data?.error === "string" && data.error) return data.error;
  return status >= 500 || (status >= 200 && status < 300) ? PENDING_CONNECT_MAYBE : PENDING_CONNECT_FAILED;
}

/**
 * Opens when Settings has `?choose=<id>`: a Facebook, Instagram or LinkedIn
 * connect found several accounts and connected none of them. The user picks
 * one (POST) or cancels (DELETE). Owner-only, like the connect itself.
 */
/** `workspaceId`: the workspace this page was rendered for; the route refuses any other (F3). */
export function PendingConnectionDialog({ workspaceId }: { workspaceId: string }) {
  const searchParams = useSearchParams();
  const pendingId = searchParams.get("choose");
  // False on the server and on the hydrating render, true after. The server
  // has no document, so <Dialog> sends no HTML; opening on the hydrating render
  // would portal into <body> against that empty HTML: React #418.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);

  if (!pendingId || !hydrated) return null;

  // key: a different ?choose= id starts over — fresh fetch, no stale choice.
  return <PendingConnectionChoice key={pendingId} pendingId={pendingId} workspaceId={workspaceId} />;
}

function PendingConnectionChoice({ pendingId, workspaceId }: { pendingId: string; workspaceId: string }) {
  const router = useRouter();
  const endpoint = `/api/connections/pending/${encodeURIComponent(pendingId)}`;

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "cancel" | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // R42 review: a refused Cancel's sentence; while it shows, Close leaves.
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Both choices end by moving to /settings; if the page comes back from the cache, its buttons do too.
  useResetOnReturnFromCache(setBusy, null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // R32: for the workspace this page was drawn for; a refusal's sentence is shown below.
        const response = await fetch(withWorkspaceId(choiceAddress(endpoint, rememberedChoicePlatform(pendingId)), workspaceId));
        const data = (await response.json().catch(() => null)) as
          | { platform?: ChoosablePlatform; candidates?: Candidate[]; error?: string }
          | null;
        if (cancelled) return;
        if (response.status === 404) {
          setLoad({ status: "expired", message: pendingGoneText(data) });
        } else if (
          response.ok &&
          data?.platform &&
          data.platform in COPY &&
          Array.isArray(data.candidates)
        ) {
          rememberChoicePlatform(pendingId, data.platform);
          setLoad({ status: "ready", platform: data.platform, candidates: data.candidates });
        } else {
          setLoad({ status: "error", message: pendingLoadFailedText(data) });
        }
      } catch {
        if (!cancelled) setLoad({ status: "error", message: pendingLoadFailedText(null) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, pendingId, workspaceId]);

  // Drops ?choose= so the dialog stays closed.
  const leave = () => router.replace("/settings");

  /** `pressed`: Connect, which a gone answer removes with the radios and Cancel. */
  async function handleConnect(pressed: HTMLElement | null) {
    if (!selectedId || busy) return;
    setBusy("connect");
    setConnectError(null);
    setCancelError(null);

    try {
      const response = await fetchOrNoAnswer(choiceAddress(endpoint, load.status === "ready" ? load.platform : null), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: selectedId, workspaceId }),
      });
      const data = (await response.json().catch(() => null)) as
        | { platform?: string; error?: string; sameEnd?: boolean }
        | null;

      if (response.status === 404) {
        focusAfterPress(pressed, () => closeRef.current);
        setLoad({ status: "expired", message: pendingGoneText(data) });
        setBusy(null);
        return;
      }
      if (!response.ok || !data?.platform) {
        setConnectError(pendingConnectFailureText(response.status, data));
        setBusy(null);
        return;
      }

      // The same success banner the OAuth callback shows for a lone account
      // (lib/oauthResult.ts), over a freshly rendered connections list.
      // R7 review 4: with same_end when the saved LinkedIn sign-in still ends within a week.
      router.replace(`/settings?${connectedSuccessQuery(data.platform, data.sameEnd === true)}`);
    } catch {
      setConnectError(PENDING_CONNECT_MAYBE);
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (busy) return;
    setBusy("cancel");
    setConnectError(null);
    setCancelError(null);
    try {
      // With the platform, so the route's fallback sentence names it.
      const response = await fetchOrNoAnswer(choiceAddress(endpoint, load.status === "ready" ? load.platform : null), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const outcome = pendingCancelOutcome(response.status, data, load.status === "ready" ? load.platform : null);
      if ("error" in outcome) {
        // R42 review: the choice still waits, so the dialog stays and says so; Close then leaves.
        setCancelError(outcome.error);
        setBusy(null);
        return;
      }
    } catch {
      // No answer: nothing to undo, and an uncancelled choice expires on its own.
    }
    leave();
  }

  const handleClose = () => {
    if (busy) return;
    if (load.status === "expired" || cancelError) {
      leave();
    } else {
      void handleCancel();
    }
  };

  const copy = load.status === "ready" ? COPY[load.platform] : null;
  const title = copy?.title ?? "Choose an account to connect";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {copy ? <DialogDescription>{copy.description}</DialogDescription> : null}
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        {load.status === "loading" ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">Loading your accounts…</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : load.status === "expired" ? (
          <Alert variant="warning">{load.message}</Alert>
        ) : load.status === "error" ? (
          <Alert variant="danger">{load.message}</Alert>
        ) : (
          <fieldset className="flex flex-col gap-2" disabled={busy !== null}>
            <legend className="sr-only">{title}</legend>
            {load.candidates.map((candidate) => {
              const checked = selectedId === candidate.id;
              return (
                <label
                  key={candidate.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border p-3 transition-colors",
                    checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                  )}
                >
                  <input
                    type="radio"
                    name="pending-connection-candidate"
                    value={candidate.id}
                    checked={checked}
                    onChange={() => {
                      setSelectedId(candidate.id);
                      setConnectError(null);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium text-foreground">
                      {candidate.name}
                    </span>
                    {candidate.detail ? (
                      <span className="block break-words text-xs text-muted-foreground">
                        {candidate.detail}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {connectError || cancelError ? (
          <p role="alert" className="text-xs text-destructive">
            {connectError ?? cancelError}
          </p>
        ) : null}
      </DialogBody>

      <DialogFooter>
        {load.status === "ready" ? (
          <>
            <Button
              variant="outline"
              onClick={handleCancel}
              loading={busy === "cancel"}
              aria-disabled={busy !== null || undefined}
            >
              Cancel
            </Button>
            <Button
              onClick={(event) => handleConnect(event.currentTarget)}
              loading={busy === "connect"}
              disabled={!selectedId}
              aria-disabled={busy !== null || undefined}
            >
              {busy === "connect" ? "Connecting…" : "Connect"}
            </Button>
          </>
        ) : (
          <Button ref={closeRef} variant="outline" onClick={handleClose} disabled={busy !== null}>
            Close
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
