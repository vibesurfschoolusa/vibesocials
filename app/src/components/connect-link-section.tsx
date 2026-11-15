"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import type { Platform } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ClientLinkPlanNotice } from "@/components/client-link-plan-notice";
import { announceClientLinksReplaced } from "@/components/client-links-refresh";
import { formatDisplayDate } from "@/lib/displayDate";
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

/**
 * Makes, replaces (POST) or turns off (DELETE) the link. On success it is
 * announced (R6 review low 2), so the Team card's "Make new client links"
 * shows or hides without a reload. A network failure throws.
 */
export async function changeConnectLink(
  fetchImpl: typeof fetch,
  method: "POST" | "DELETE",
  body: object,
  announce: () => void = () => announceClientLinksReplaced("connect-link"),
): Promise<{ ok: true; link: ConnectLinkDto | null } | { ok: false; error: string | null }> {
  const response = await fetchImpl("/api/workspaces/connect-link", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { link?: ConnectLinkDto; error?: string } | null;
  if (!response.ok || (method === "POST" && !data?.link)) {
    return { ok: false, error: typeof data?.error === "string" ? data.error : null };
  }
  announce();
  return { ok: true, link: method === "POST" ? data!.link! : null };
}

export interface ConnectLinkViewProps {
  available: Platform[];
  link: ConnectLinkDto | null;
  selected: Platform[];
  busy: boolean;
  onToggle: (platform: Platform) => void;
  onCreate: () => void;
  onCopy: () => void;
  onReplace: () => void;
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
  onTurnOff,
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
                <Button type="button" variant="outline" onClick={onCopy}>
                  <Copy className="h-4 w-4" aria-hidden />
                  Copy
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This link can&apos;t be shown again. Replace it to get a new one.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Offers: {link.platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ")}
            </p>
            <p className="text-sm text-muted-foreground">Expires on {formatDisplayDate(link.expiresAt)}</p>
            <p className="text-sm text-muted-foreground">
              {link.lastUsedAt ? `Last used ${formatDisplayDate(link.lastUsedAt)}` : "Not used yet"}
            </p>
            <div className="flex flex-wrap gap-2">
              {workspaceBlocked || pausedByPlan ? null : (
                <Button type="button" variant="outline" size="sm" onClick={onReplace}>
                  Replace link
                </Button>
              )}
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">The platforms the link offers</legend>
              {available.map((platform) => (
                <label key={platform} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(platform)}
                    onChange={() => onToggle(platform)}
                  />
                  {PLATFORM_LABELS[platform]}
                </label>
              ))}
            </fieldset>
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

function ConnectLinkPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "hidden" | "ready">("loading");
  const [available, setAvailable] = useState<Platform[]>([]);
  const [link, setLink] = useState<ConnectLinkDto | null>(null);
  const [pausedByPlan, setPausedByPlan] = useState(false);
  const [workspaceBlocked, setWorkspaceBlocked] = useState<string | null>(null);
  const [selected, setSelected] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/workspaces/connect-link?workspaceId=${encodeURIComponent(workspaceId)}`);
        const data = (await response.json().catch(() => null)) as
          | { link?: ConnectLinkDto | null; available?: Platform[]; pausedByPlan?: boolean; workspaceBlocked?: string }
          | null;
        if (cancelled) return;
        if (!response.ok || !data) {
          setState("hidden");
          return;
        }
        setAvailable(data.available ?? []);
        setLink(data.link ?? null);
        setPausedByPlan(data.pausedByPlan === true);
        setWorkspaceBlocked(typeof data.workspaceBlocked === "string" ? data.workspaceBlocked : null);
        setState("ready");
      } catch {
        if (!cancelled) setState("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const onToggle = useCallback((platform: Platform) => {
    setSelected((current) =>
      current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform],
    );
  }, []);

  /** The link route, with a network failure said in a toast (and thrown, so a confirm stays open). */
  const send = useCallback(
    async (method: "POST" | "DELETE", body: object) => {
      try {
        return await changeConnectLink(fetch, method, body);
      } catch (error) {
        toast.error("Couldn't reach Vibe Socials. Check your connection and try again.");
        throw error;
      }
    },
    [toast],
  );

  // Create and Replace are the same call: the server revokes any old link.
  // Replace keeps the platforms the old link offered. Throws on failure, so the
  // confirm dialog stays open; the toast says why.
  const makeLink = useCallback(
    async (platforms: Platform[]) => {
      const result = await send("POST", { workspaceId, platforms });
      if (!result.ok || !result.link) {
        toast.error((!result.ok && result.error) || "Couldn't make the link. Try again.");
        throw new Error("CREATE_FAILED");
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
      throw new Error("REVOKE_FAILED");
    }
    setLink(null);
    setSelected([]);
    toast.success("The link is off. It no longer works.");
  }, [send, toast, workspaceId]);

  async function onCreate() {
    setBusy(true);
    try {
      await makeLink(selected);
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
      onReplace={() => setConfirm("replace")}
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
              ? "The old link stops working. Your client will need the new one."
              : "The old link stops working. Accounts your client already connected stay connected."
          }
          confirmText={confirm === "replace" ? "Replace link" : "Turn off"}
          destructive
          onConfirm={confirm === "replace" ? () => makeLink(link?.platforms ?? []) : turnOff}
        />
      }
    />
  );
}

/** Owners only: a member gets nothing at all. */
export function ConnectLinkSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  return isOwner ? <ConnectLinkPanel workspaceId={workspaceId} /> : null;
}
