"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { Copy } from "lucide-react";
import type { Platform } from "@prisma/client";

import { LoadError } from "@/components/load-error";
import { Alert } from "@/components/ui/alert";
import { AnnouncedText } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CONFIRM_NOTHING_SENT_MESSAGE, ConfirmDialog, ConfirmFailureShown } from "@/components/ui/dialog";
import { answerLostText } from "@/lib/answerLost";
import { sendActionRequest } from "@/lib/queueActions";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ClientLinkPlanNotice } from "@/components/client-link-plan-notice";
import { announceClientLinksReplaced } from "@/components/client-links-refresh";
import { formatDisplayDate } from "@/lib/displayDate";
import { focusAfterPress } from "@/lib/focusAfter";
import { clientLinkLoadTexts, readClientLinkCard } from "@/lib/clientLinkCardRead";
import { PLATFORM_LABELS } from "@/lib/platforms";

/**
 * The Client connect link group in Settings (2026-11-11), for owners. One link
 * per workspace (api/workspaces/connect-link): the owner ticks what it offers,
 * creates it, copies the address for the client, and can replace it or turn
 * it off, each behind a confirm, as the review and upload link panels (R5-pages
 * L4). Members never see it; the routes refuse them as well.
 */

export type ConnectLinkDto = {
  url: string | null;
  platforms: Platform[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
};

/*
 * Lead review 2 (R28 NN2): the route turns the old link off before it answers,
 * so a lost answer may leave a new link, or none.
 */
export const CONNECT_LINK_MAYBE_MADE_MESSAGE = answerLostText(
  "a new connect link may have been made, which turns any old one off",
  "Reload this page and copy the link before you send it.",
);
export const CONNECT_LINK_MAYBE_OFF_MESSAGE = answerLostText(
  "the connect link may have been turned off",
  "Reload this page to see.",
);

/**
 * Makes, replaces (POST) or turns off (DELETE) the link. On success it is
 * announced (R6 review low 2), so the Team card's "Make new client links"
 * shows or hides without a reload. `notSent`: offline at the press. `lost`: no
 * answer, or a gateway's 5xx; it may have gone through, so that is announced
 * too and the Team card reads the links again.
 */
export async function changeConnectLink(
  fetchImpl: typeof fetch,
  method: "POST" | "DELETE",
  body: object,
  announce: () => void = () => announceClientLinksReplaced("connect-link"),
  online?: () => boolean,
): Promise<
  | { ok: true; link: ConnectLinkDto | null }
  | { ok: false; error: string | null; lost?: true; notSent?: true }
> {
  const answer = await sendActionRequest(
    "/api/workspaces/connect-link",
    { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { fetchImpl, ...(online ? { online } : {}) },
  );
  if (answer.kind === "not_sent") return { ok: false, error: null, notSent: true };
  if (answer.kind === "no_answer") {
    announce();
    return { ok: false, error: null, lost: true };
  }
  const { response } = answer;
  const data = (await response.json().catch(() => null)) as { link?: ConnectLinkDto; error?: string } | null;
  // R29 OO1 (client-journey L4): an OK answer to Make whose link can't be read:
  // the link was made and the old one turned off, so it is lost, as on Queue and Media.
  if (response.ok && method === "POST" && !data?.link) {
    announce();
    return { ok: false, error: null, lost: true };
  }
  if (!response.ok) {
    return { ok: false, error: typeof data?.error === "string" ? data.error : null };
  }
  announce();
  return { ok: true, link: method === "POST" ? data!.link! : null };
}

/**
 * R32 client-journey L3: what Replace's boxes start ticked with. A platform the
 * site no longer offers (its settings were removed) would be refused with
 * "Untick it", and it has no box, so it is left out, as "Make new client
 * links" does (api/workspaces/client-links). R47 client-journey L4: the owner
 * can then tick more or fewer.
 */
export function replacePlatforms(link: ConnectLinkDto | null, available: readonly Platform[]): Platform[] {
  return (link?.platforms ?? []).filter((platform) => available.includes(platform));
}

/** The Replace confirm's sentence, naming what the new link offers: the ticked platforms. */
export function replaceDescription(platforms: readonly Platform[]): string {
  const base = "The old link stops working. Your client will need the new one.";
  if (platforms.length === 0) return base;
  return `${base} It offers ${platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ")}.`;
}

/** The link's platforms the site no longer offers, in one line, or null. */
export function droppedPlatformsLine(link: ConnectLinkDto, available: readonly Platform[]): string | null {
  const dropped = link.platforms.filter((platform) => !available.includes(platform));
  if (dropped.length === 0) return null;
  const names = dropped.map((platform) => PLATFORM_LABELS[platform]).join(", ");
  return `No longer offered: ${names}. This site can't connect ${dropped.length === 1 ? "it" : "them"} now.`;
}

/** Replace pressed while the site offers no platform: nothing can be ticked, so the steps that work. */
export const REPLACE_NONE_OFFERED_MESSAGE =
  "No platform can be connected on this site now, so there is nothing to tick for a new link. Press Turn off to stop this one, or Cancel to keep it.";

export interface ConnectLinkViewProps {
  available: Platform[];
  link: ConnectLinkDto | null;
  selected: Platform[];
  busy: boolean;
  onToggle: (platform: Platform) => void;
  onCreate: (event?: MouseEvent<HTMLButtonElement>) => void;
  onCopy: () => void;
  /** The new link's Copy button, which takes focus after Create link. */
  copyRef?: Ref<HTMLButtonElement>;
  /** Replace link: the first press shows the boxes (replacing), the next opens the confirm. */
  onReplace: () => void;
  /** R47 client-journey L4: Replace's boxes are shown, ticked as `selected`. */
  replacing?: boolean;
  onCancelReplace?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** The first box, which takes focus when Replace shows them. */
  firstBoxRef?: Ref<HTMLInputElement>;
  /** The Replace link button, which takes focus after Cancel. */
  replaceRef?: Ref<HTMLButtonElement>;
  /** Cancel, which takes focus when Replace has no box to show. */
  cancelRef?: Ref<HTMLButtonElement>;
  onTurnOff: () => void;
  /** The confirm dialog, rendered inside the card. */
  dialog?: ReactNode;
  /** P1: the owner GET's pausedByPlan: the plan does not include client links. */
  pausedByPlan?: boolean;
  /** R21: the owner GET's sentence when the workspace is paused or its plan has ended. */
  workspaceBlocked?: string | null;
}

export function ConnectLinkSectionView({
  available,
  link,
  selected,
  busy,
  onToggle,
  onCreate,
  onCopy,
  onReplace,
  replacing = false,
  onCancelReplace,
  firstBoxRef,
  replaceRef,
  cancelRef,
  onTurnOff,
  copyRef,
  dialog = null,
  pausedByPlan = false,
  workspaceBlocked = null,
}: ConnectLinkViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Client connect link</CardTitle>
        <CardDescription>
          Send this link to a client so they can connect their own accounts to this workspace, without an
          account here and without sharing a password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {link ? (
          <>
            {/* P1 and R21: a paused link's address answers "not active", so it is not offered to copy. */}
            {workspaceBlocked ? (
              <p className="text-sm text-muted-foreground">{workspaceBlocked}</p>
            ) : pausedByPlan ? (
              <ClientLinkPlanNotice paused expires />
            ) : link.url ? (
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={link.url}
                  aria-label="Client connect link"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button ref={copyRef} type="button" variant="outline" onClick={onCopy}>
                  <Copy className="h-4 w-4" aria-hidden />
                  Copy
                </Button>
              </div>
            ) : available.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                This link can&apos;t be shown again. Replace it to get a new one.
              </p>
            ) : null}
            {/* R32 lead review: what the link really offers now, as /c shows it. */}
            {replacePlatforms(link, available).length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Offers: {replacePlatforms(link, available).map((platform) => PLATFORM_LABELS[platform]).join(", ")}
              </p>
            ) : null}
            {droppedPlatformsLine(link, available) ? (
              <p className="text-sm text-muted-foreground">{droppedPlatformsLine(link, available)}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">Expires on {formatDisplayDate(link.expiresAt)}</p>
            <p className="text-sm text-muted-foreground">
              {link.lastUsedAt ? `Last used ${formatDisplayDate(link.lastUsedAt)}` : "Not used yet"}
            </p>
            {/* R47 lead review: Replace is always offered; with no box to tick it says so. */}
            {replacing && available.length === 0 ? (
              <p className="text-sm text-muted-foreground">{REPLACE_NONE_OFFERED_MESSAGE}</p>
            ) : replacing ? (
              <PlatformBoxes
                legend="The platforms the new link offers"
                available={available}
                selected={selected}
                onToggle={onToggle}
                firstBoxRef={firstBoxRef}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {workspaceBlocked || pausedByPlan ? null : (
                <Button
                  ref={replaceRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={replacing && selected.length === 0}
                  onClick={onReplace}
                >
                  Replace link
                </Button>
              )}
              {replacing ? (
                <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={onCancelReplace}>
                  Cancel
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={onTurnOff}>
                Turn off
              </Button>
            </div>
          </>
        ) : workspaceBlocked ? (
          <p className="text-sm text-muted-foreground">{workspaceBlocked}</p>
        ) : pausedByPlan ? (
          <ClientLinkPlanNotice paused={false} />
        ) : available.length === 0 ? (
          <p className="text-sm text-muted-foreground">No platform can be connected on this site yet.</p>
        ) : (
          <>
            <PlatformBoxes
              legend="The platforms the link offers"
              available={available}
              selected={selected}
              onToggle={onToggle}
            />
            <Button type="button" loading={busy} disabled={selected.length === 0} onClick={onCreate}>
              Create link
            </Button>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Facebook, Instagram and the other platforms let people outside your team connect only after the
          platform has approved this app.
        </p>
      </CardContent>
      {dialog}
    </Card>
  );
}

/** A box per platform the site offers: Create link's, and Replace's (R47 client-journey L4). */
function PlatformBoxes({
  legend,
  available,
  selected,
  onToggle,
  firstBoxRef,
}: {
  legend: string;
  available: Platform[];
  selected: Platform[];
  onToggle: (platform: Platform) => void;
  firstBoxRef?: Ref<HTMLInputElement>;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {available.map((platform, index) => (
        <label key={platform} className="flex items-center gap-2 text-sm">
          <input
            ref={index === 0 ? firstBoxRef : undefined}
            type="checkbox"
            checked={selected.includes(platform)}
            onChange={() => onToggle(platform)}
          />
          {PLATFORM_LABELS[platform]}
        </label>
      ))}
    </fieldset>
  );
}

const CONNECT_LINK_LOAD_TEXTS = clientLinkLoadTexts("client connect link");

type ConnectLinkAnswer = {
  link: ConnectLinkDto | null;
  available?: Platform[];
  pausedByPlan?: boolean;
  workspaceBlocked?: string;
};

function isConnectLinkAnswer(data: unknown): data is ConnectLinkAnswer {
  return typeof data === "object" && data !== null && "link" in data;
}

/**
 * R42 pages-b L1: the card never hides. It is rendered for owners only, so a
 * failed read says what happened, with Retry, and a workspace refusal or a 403
 * (the viewer's role or workspace changed) asks for a reload
 * (readClientLinkCard), as the upload-link card does.
 */
function ConnectLinkPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "ready" | "changed" | "failed">("loading");
  const [changedMessage, setChangedMessage] = useState("");
  const [loadError, setLoadError] = useState(CONNECT_LINK_LOAD_TEXTS.failed);
  // Bumped by Retry, so the read runs again.
  const [attempt, setAttempt] = useState(0);
  const [available, setAvailable] = useState<Platform[]>([]);
  const [link, setLink] = useState<ConnectLinkDto | null>(null);
  const [pausedByPlan, setPausedByPlan] = useState(false);
  const [workspaceBlocked, setWorkspaceBlocked] = useState<string | null>(null);
  const [selected, setSelected] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);
  const [replacing, setReplacing] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const firstBoxRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Replace link stays where it was and the boxes appear above it: focus goes to
  // the first box, or to Cancel when there is none (Replace link is disabled then).
  useEffect(() => {
    if (replacing) (firstBoxRef.current ?? cancelRef.current)?.focus();
  }, [replacing]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const read = await readClientLinkCard(
        `/api/workspaces/connect-link?workspaceId=${encodeURIComponent(workspaceId)}`,
        CONNECT_LINK_LOAD_TEXTS,
        isConnectLinkAnswer,
      );
      if (cancelled) return;
      if (read.kind === "changed") {
        setChangedMessage(read.message);
        setState("changed");
      } else if (read.kind === "failed") {
        setLoadError(read.message);
        setState("failed");
      } else {
        const data = read.data;
        setAvailable(data.available ?? []);
        setLink(data.link ?? null);
        setPausedByPlan(data.pausedByPlan === true);
        setWorkspaceBlocked(typeof data.workspaceBlocked === "string" ? data.workspaceBlocked : null);
        setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, attempt]);

  const onToggle = useCallback((platform: Platform) => {
    setSelected((current) =>
      current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform],
    );
  }, []);

  // Lead review 2: after a lost answer the panel reads the link again, so it
  // shows the one that works and no dead link is left to copy. A failed read
  // keeps what is shown; the sentence says to reload.
  const readLink = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/connect-link?workspaceId=${encodeURIComponent(workspaceId)}`);
      const data = (await response.json().catch(() => null)) as { link?: ConnectLinkDto | null } | null;
      if (response.ok && data && "link" in data) setLink(data.link ?? null);
    } catch {
      // Still no connection: the sentence already says to reload.
    }
  }, [workspaceId]);

  /** The link route; offline or a lost answer said in a toast (and thrown, so a confirm stays open). */
  const send = useCallback(
    async (method: "POST" | "DELETE", body: object) => {
      const result = await changeConnectLink(fetch, method, body);
      if (!result.ok && result.notSent) {
        toast.error(CONFIRM_NOTHING_SENT_MESSAGE);
        throw new ConfirmFailureShown("NOT_SENT");
      }
      if (!result.ok && result.lost) {
        toast.error(method === "POST" ? CONNECT_LINK_MAYBE_MADE_MESSAGE : CONNECT_LINK_MAYBE_OFF_MESSAGE);
        void readLink();
        throw new ConfirmFailureShown("ANSWER_LOST");
      }
      return result;
    },
    [readLink, toast],
  );

  // Create and Replace are the same call: the server revokes any old link.
  // Replace sends the ticked boxes, which start as replacePlatforms. Throws on
  // failure, so the confirm dialog stays open; the toast says why.
  const makeLink = useCallback(
    async (platforms: Platform[]) => {
      const result = await send("POST", { workspaceId, platforms });
      if (!result.ok || !result.link) {
        toast.error((!result.ok && result.error) || "Couldn't make the link. Try again.");
        throw new ConfirmFailureShown("CREATE_FAILED");
      }
      setLink(result.link);
      toast.success("New link ready. Copy it and send it to your client.");
    },
    [send, toast, workspaceId],
  );

  const turnOff = useCallback(async () => {
    const result = await send("DELETE", { workspaceId });
    if (!result.ok) {
      toast.error(result.error ?? "Couldn't turn the link off. Try again.");
      throw new ConfirmFailureShown("REVOKE_FAILED");
    }
    setLink(null);
    setSelected([]);
    setReplacing(false);
    toast.success("The link is off. It no longer works.");
  }, [send, toast, workspaceId]);

  async function onCreate(event?: MouseEvent<HTMLButtonElement>) {
    const pressed = event?.currentTarget ?? null;
    setBusy(true);
    try {
      await makeLink(selected);
      // R27 MM3: Create link is replaced by the new link; focus goes to its Copy button.
      focusAfterPress(pressed, () => copyRef.current);
    } catch {
      // Already shown as a toast.
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy the link. Copy it by hand instead.");
    }
  }

  if (state === "changed") {
    return (
      <Alert variant="warning" title="Client connect link">
        {/* A refusal: LoadError offers Reload page, never Retry. */}
        <LoadError message={changedMessage} onRetry={() => window.location.reload()} />
      </Alert>
    );
  }
  if (state === "failed") {
    return (
      <Alert variant="danger" title="Couldn't load the client connect link">
        <LoadError
          message={loadError}
          onRetry={() => {
            setState("loading");
            setAttempt((count) => count + 1);
          }}
        />
      </Alert>
    );
  }
  // After Retry, a line in the card's place says it is loading, and takes focus (LoadError).
  // AnnouncedText, as the upload-link card's, since this view comes and goes.
  if (state === "loading" && attempt > 0) {
    return <AnnouncedText className="sr-only" text="Loading the client connect link…" />;
  }
  if (state !== "ready") return null;
  return (
    <ConnectLinkSectionView
      available={available}
      link={link}
      selected={selected}
      busy={busy}
      onToggle={onToggle}
      onCreate={onCreate}
      onCopy={onCopy}
      copyRef={copyRef}
      onReplace={() => {
        if (replacing) {
          setConfirm("replace");
          return;
        }
        setSelected(replacePlatforms(link, available));
        setReplacing(true);
      }}
      replacing={replacing}
      onCancelReplace={(event) => {
        focusAfterPress(event.currentTarget, () => replaceRef.current);
        setReplacing(false);
      }}
      firstBoxRef={firstBoxRef}
      replaceRef={replaceRef}
      cancelRef={cancelRef}
      onTurnOff={() => setConfirm("off")}
      pausedByPlan={pausedByPlan}
      workspaceBlocked={workspaceBlocked}
      dialog={
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={confirm === "replace" ? "Replace the client connect link?" : "Turn off the client connect link?"}
          description={
            confirm === "replace"
              ? replaceDescription(selected)
              : "The old link stops working. Accounts your client already connected stay connected."
          }
          confirmText={confirm === "replace" ? "Replace link" : "Turn off"}
          destructive
          onConfirm={
            confirm === "replace"
              ? async () => {
                  await makeLink(selected);
                  setReplacing(false);
                }
              : turnOff
          }
        />
      }
    />
  );
}

/** Owners only: a member gets nothing at all. */
export function ConnectLinkSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  return isOwner ? <ConnectLinkPanel workspaceId={workspaceId} /> : null;
}
