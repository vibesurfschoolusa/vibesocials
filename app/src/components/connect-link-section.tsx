"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import type { Platform } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { PLATFORM_LABELS } from "@/lib/platforms";

/**
 * The Client connect link group in Settings (2026-11-11), for owners. One link
 * per workspace (api/workspaces/connect-link): the owner ticks what it offers,
 * creates it, copies the address for the client, and can revoke it. Members
 * never see it; the routes refuse them as well.
 */

export type ConnectLinkDto = {
  url: string | null;
  platforms: Platform[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export interface ConnectLinkViewProps {
  available: Platform[];
  link: ConnectLinkDto | null;
  selected: Platform[];
  busy: boolean;
  onToggle: (platform: Platform) => void;
  onCreate: () => void;
  onCopy: () => void;
  onRevoke: () => void;
}

export function ConnectLinkSectionView({
  available,
  link,
  selected,
  busy,
  onToggle,
  onCreate,
  onCopy,
  onRevoke,
}: ConnectLinkViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="connect-link" className="scroll-mt-20 text-base">Client connect link</CardTitle>
        <CardDescription>
          Send this link to a client so they can connect their own accounts to this workspace, without an
          account here and without sharing a password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {link ? (
          <>
            {link.url ? (
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
                This link can&apos;t be shown again. Revoke it and create a new one.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Offers: {link.platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ")}
            </p>
            <p className="text-sm text-muted-foreground">Expires on {formatDate(link.expiresAt)}</p>
            <p className="text-sm text-muted-foreground">
              {link.lastUsedAt ? `Last used ${formatDate(link.lastUsedAt)}` : "Not used yet"}
            </p>
            <Button type="button" variant="outline" size="sm" loading={busy} onClick={onRevoke}>
              Revoke
            </Button>
          </>
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
    </Card>
  );
}

function ConnectLinkPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "hidden" | "ready">("loading");
  const [available, setAvailable] = useState<Platform[]>([]);
  const [link, setLink] = useState<ConnectLinkDto | null>(null);
  const [selected, setSelected] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/workspaces/connect-link?workspaceId=${encodeURIComponent(workspaceId)}`);
        const data = (await response.json().catch(() => null)) as
          | { link?: ConnectLinkDto | null; available?: Platform[] }
          | null;
        if (cancelled) return;
        if (!response.ok || !data) {
          setState("hidden");
          return;
        }
        setAvailable(data.available ?? []);
        setLink(data.link ?? null);
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

  async function onCreate() {
    setBusy(true);
    try {
      const response = await fetch("/api/workspaces/connect-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, platforms: selected }),
      });
      const data = (await response.json().catch(() => null)) as { link?: ConnectLinkDto; error?: string } | null;
      if (!response.ok || !data?.link) {
        toast.error(data?.error ?? "Couldn't make the link. Try again.");
        return;
      }
      setLink(data.link);
      toast.success("New link ready. Copy it and send it to your client.");
    } catch {
      toast.error("Couldn't make the link. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    setBusy(true);
    try {
      const response = await fetch("/api/workspaces/connect-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "Couldn't revoke the link. Try again.");
        return;
      }
      setLink(null);
      setSelected([]);
      toast.success("The link is revoked. It no longer works.");
    } catch {
      toast.error("Couldn't revoke the link. Try again.");
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
      onRevoke={onRevoke}
    />
  );
}

/** Owners only: a member gets nothing at all. */
export function ConnectLinkSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  return isOwner ? <ConnectLinkPanel workspaceId={workspaceId} /> : null;
}
