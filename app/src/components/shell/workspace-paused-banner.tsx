"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newestAnswer, subscribeWorkspaceChange } from "@/lib/workspaceChangeEvent";
import { VERIFY_RESEND_MAYBE_SENT_MESSAGE } from "@/app/verify-email/verifyOutcome";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { readWorkspaceRefusalText, withWorkspaceId } from "@/lib/workspaceChanged";

/**
 * The one banner a paused workspace's members see on every signed-in page
 * (2026-11-10), and (21a, billing on) a workspace whose trial or plan ended.
 * Asks GET /api/workspaces/status on each page change, so a pause or resume
 * shows on the next navigation, and on each announceWorkspaceChange (R16: an
 * owner who makes themselves a member gets the member's wording without
 * navigating); renders nothing unless the workspace is
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
  // The navigation read and the announce read share one order: the later one shows.
  const [reads] = useState(newestAnswer);
  // R32: the workspace this tab was drawn for, read once and kept across page changes.
  const [workspaceOf] = useState(() => tabWorkspace(fetch));

  useEffect(() => {
    if (status !== "authenticated") return;
    return readWorkspaceStatusOnce(setWorkspaceStatus, workspaceOf, fetch, reads);
  }, [status, pathname, reads, workspaceOf]);

  useEffect(() => {
    if (status !== "authenticated") return;
    return watchWorkspaceStatus(setWorkspaceStatus, workspaceOf, fetch, reads);
  }, [status, reads, workspaceOf]);

  const confirmShown = confirmEmailBannerShown(workspaceStatus);
  useEffect(() => {
    onConfirmEmailShownChange?.(confirmShown);
  }, [confirmShown, onConfirmEmailShownChange]);

  async function handleResend() {
    setSending(true);
    try {
      // The existing route, with its own per-person limit of 3 in 15 minutes.
      const response = await fetchOrNoAnswer("/api/auth/resend-verification", { method: "POST" });
      if (response.ok) {
        success("We sent a new link. Open it from your inbox to start posting.");
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        error(data?.error ?? "Could not send the link. Try again in a minute.");
      }
    } catch (caught) {
      error(isNoAnswer(caught) ? VERIFY_RESEND_MAYBE_SENT_MESSAGE : "Could not send the link. Try again in a minute.");
    } finally {
      setSending(false);
    }
  }

  return <WorkspaceStatusAlert status={workspaceStatus} sending={sending} onResend={handleResend} />;
}

/**
 * R32: the workspace this tab was drawn for: the active one in the tab's first
 * workspace list (the one the account menu names), kept for the life of the
 * tab, since a switch in this tab is a full load (afterWorkspaceChange). A
 * failed read is asked again next time; null until one is answered.
 */
export function tabWorkspace(fetchImpl: typeof fetch = fetch): () => Promise<string | null> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    try {
      const response = await fetchImpl("/api/workspaces", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { workspaces?: { id?: unknown; isActive?: unknown }[] } | null;
      const active = response.ok ? data?.workspaces?.find((workspace) => workspace.isActive === true) : undefined;
      if (typeof active?.id === "string") known = active.id;
    } catch {
      // Asked again on the next read.
    }
    return known;
  };
}

/**
 * The status route's answer for the tab's workspace, or null when it can't be
 * read (best effort: the routes still refuse with the same message). R32: a
 * tab left on it after another tab switched gets the shared sentence as the
 * banner's line, never the other workspace's pause or trial.
 */
async function fetchWorkspaceStatus(
  fetchImpl: typeof fetch,
  workspaceOf: () => Promise<string | null>,
): Promise<WorkspaceStatus | null> {
  try {
    const workspaceId = await workspaceOf();
    if (!workspaceId) return null;
    const response = await fetchImpl(withWorkspaceId("/api/workspaces/status", workspaceId), { cache: "no-store" });
    const refusal = await readWorkspaceRefusalText(response);
    if (refusal) return { ...NO_STATUS, message: refusal };
    if (!response.ok) return null;
    return readWorkspaceStatus(await response.json());
  } catch {
    return null;
  }
}

/**
 * One read of the status, for a page change; `onStatus` gets a good answer
 * unless a read started later has shown its own. The answer cancels it.
 */
export function readWorkspaceStatusOnce(
  onStatus: (status: WorkspaceStatus) => void,
  workspaceOf: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
  reads = newestAnswer(),
): () => void {
  let cancelled = false;
  const show = reads.next();
  void fetchWorkspaceStatus(fetchImpl, workspaceOf).then((next) => {
    if (!cancelled && next && show()) onStatus(next);
  });
  return () => {
    cancelled = true;
  };
}

/**
 * Reads the status again on each announceWorkspaceChange, in the same order
 * as `reads`. The answer stops listening, and an answer that arrives after
 * that is dropped.
 */
export function watchWorkspaceStatus(
  onStatus: (status: WorkspaceStatus) => void,
  workspaceOf: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
  reads = newestAnswer(),
): () => void {
  let stopped = false;
  const unsubscribe = subscribeWorkspaceChange(() => {
    const show = reads.next();
    void fetchWorkspaceStatus(fetchImpl, workspaceOf).then((next) => {
      if (!stopped && next && show()) onStatus(next);
    });
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

export type WorkspaceStatus = {
  message: string | null;
  notice: string | null;
  emailUnconfirmed: boolean;
  /** S1: the quiet line for the rest of a trial (owners, billing on). */
  daysLeft: string | null;
  /** S1: an owner's ended trial or plan: the banner links to Settings, Plan. */
  planLink: boolean;
};

const NO_STATUS: WorkspaceStatus = { message: null, notice: null, emailUnconfirmed: false, daysLeft: null, planLink: false };

/** GET /api/workspaces/status's answer, keeping only fields of the right type. */
export function readWorkspaceStatus(data: unknown): WorkspaceStatus {
  const body = (data ?? {}) as {
    blockedMessage?: unknown;
    trialNotice?: unknown;
    emailUnconfirmed?: unknown;
    trialDaysLeft?: unknown;
    planLink?: unknown;
  };
  const message = typeof body.blockedMessage === "string" ? body.blockedMessage : null;
  return {
    message,
    notice: typeof body.trialNotice === "string" ? body.trialNotice : null,
    emailUnconfirmed: message !== null && body.emailUnconfirmed === true,
    daysLeft: typeof body.trialDaysLeft === "string" ? body.trialDaysLeft : null,
    planLink: message !== null && body.planLink === true,
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
  const { message, notice, emailUnconfirmed, daysLeft, planLink } = status;

  if (!message && notice) {
    return (
      <div className="px-4 pt-4 md:px-6">
        <Alert variant="info" className="p-3">
          <span className="text-foreground">{notice}</span> <PlanLink />
        </Alert>
      </div>
    );
  }

  if (!message && daysLeft) {
    return (
      <p className="px-4 pt-3 text-xs text-muted-foreground md:px-6">
        {daysLeft} <PlanLink />
      </p>
    );
  }

  if (!message) return null;

  if (emailUnconfirmed) {
    return (
      <div className="px-4 pt-4 md:px-6">
        <Alert variant="warning" className="items-center p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* R20 pages L2: the sentence names the address; let it break at phone width. */}
            <span className="min-w-0 break-words text-foreground">{message}</span>
            <Button size="sm" variant="outline" loading={sending} onClick={onResend}>
              Send the link again
            </Button>
            {/* R6-new-customer L4: a mistyped address can only be fixed there. */}
            <span className="text-foreground">
              Wrong address?{" "}
              <Link href="/settings#account" className="font-medium text-primary underline-offset-4 hover:underline">
                Change it in Settings, Account
              </Link>
              .
            </span>
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="danger" className="p-3">
        <span className="text-foreground">{message}</span>
        {planLink ? (
          <>
            {" "}
            <PlanLink />
          </>
        ) : null}
      </Alert>
    </div>
  );
}

function PlanLink() {
  return (
    <Link href="/settings#plan" className="font-medium text-primary underline-offset-4 hover:underline">
      Choose a plan
    </Link>
  );
}
