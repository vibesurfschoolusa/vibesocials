"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import type { WorkspaceRole } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/** GET /api/workspaces/members list item — owner-only route (SEC-1: never fetched for a member). */
interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

/**
 * GET /api/workspaces/members/roster list item — member-safe route (SEC-1:
 * names + roles only, never emails/user ids). Consumed by `MemberView`.
 */
interface RosterEntry {
  name: string;
  role: WorkspaceRole;
}

/**
 * Locally-tracked invite metadata. Mirrors the union of what
 * `GET`/`POST /api/workspaces/invites` return: the GET always has
 * `createdAt`; the POST response doesn't, but since it's only ever read at
 * the moment of creation, "now" is filled in client-side (see `createInvite`)
 * and is never actually rendered — `freshUrl` takes over the display for
 * that state.
 */
interface InviteMeta {
  expiresAt: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

interface TeamSectionProps {
  role: WorkspaceRole;
  workspaceName: string;
}

/**
 * Settings → Team card (design doc §7). Owners get full management (rename,
 * invite link, member list + removal); members get a read-only summary.
 */
export function TeamSection({ role, workspaceName }: TeamSectionProps) {
  if (role !== "owner") {
    return <MemberView workspaceName={workspaceName} />;
  }
  return <OwnerView workspaceName={workspaceName} />;
}

/**
 * Uses the member-safe `GET /api/workspaces/members/roster` (SEC-1 — a
 * member's teammates' emails and user ids are workspace-internal data, so
 * this route returns display names + roles only; the owner-only
 * `GET /api/workspaces/members` above is the full variant). Renders the
 * workspace name, the explanatory line, and the roster list.
 *
 * Task 8 plan amendment adds "Leave workspace" (design §1 — member-only; an
 * owner never sees this view at all, so the sole-owner-can't-leave rule
 * needs no UI check here, only the API's own 400).
 */
function MemberView({ workspaceName }: { workspaceName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [leaveOpen, setLeaveOpen] = useState(false);

  // --- Roster (GET /api/workspaces/members/roster) ---
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/workspaces/members/roster");
        const data = (await response.json().catch(() => null)) as
          | { members: RosterEntry[] }
          | null;
        if (!cancelled) {
          if (response.ok && data) setRoster(data.members);
          else setRosterError(true);
        }
      } catch {
        if (!cancelled) setRosterError(true);
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ConfirmDialog contract: throw to keep the dialog open on failure (the
  // error is already surfaced via toast here, mirrors revokeInvite/
  // confirmRemove below).
  const handleLeave = useCallback(async () => {
    const response = await fetch("/api/workspaces/leave", { method: "POST" });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't leave the workspace.");
      throw new Error("LEAVE_FAILED");
    }
    toast.success("Left the workspace.");
    router.refresh();
  }, [router, toast]);

  return (
    <Card className="p-6">
      <h3 className="text-base font-semibold text-foreground">{workspaceName}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Only the workspace owner can manage members.
      </p>

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
        <h4 className="text-sm font-medium text-foreground">Members</h4>
        {rosterLoading ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : rosterError ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load members. Try reloading the page.
          </p>
        ) : roster && roster.length > 0 ? (
          <ul className="divide-y divide-border">
            {roster.map((entry, index) => (
              <li
                key={`${entry.name}-${index}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <p className="truncate text-sm text-foreground">{entry.name}</p>
                <Badge variant={entry.role === "owner" ? "default" : "secondary"}>
                  {entry.role === "owner" ? "Owner" : "Member"}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setLeaveOpen(true)}
        >
          Leave workspace
        </Button>
      </div>

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        destructive
        title="Leave this workspace?"
        description="You'll lose access to its accounts and posts. Your own account keeps working."
        confirmText="Leave"
        onConfirm={handleLeave}
      />
    </Card>
  );
}

function OwnerView({ workspaceName }: { workspaceName: string }) {
  const router = useRouter();
  const toast = useToast();

  // --- Rename (PATCH /api/workspaces/active) ---
  const [name, setName] = useState(workspaceName);
  const [savedName, setSavedName] = useState(workspaceName);
  const [savingName, setSavingName] = useState(false);

  const handleSaveName = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === savedName) return;
    setSavingName(true);
    try {
      const response = await fetch("/api/workspaces/active", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Couldn't rename workspace.");
        return;
      }
      setSavedName(trimmed);
      setName(trimmed);
      toast.success("Workspace renamed.");
      router.refresh();
    } catch {
      toast.error("Couldn't rename workspace.");
    } finally {
      setSavingName(false);
    }
  }, [name, savedName, router, toast]);

  // --- Invite link (GET/POST/DELETE /api/workspaces/invites) ---
  const [invite, setInvite] = useState<InviteMeta | null>(null);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(true);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/workspaces/invites");
        const data = (await response.json().catch(() => null)) as
          | { invite: InviteMeta | null }
          | null;
        if (!cancelled && response.ok && data) {
          setInvite(data.invite);
        }
      } catch {
        // Leave `invite` at null — worst case the owner sees "Create invite
        // link" and creating one still works fine (POST re-validates itself).
      } finally {
        if (!cancelled) setInviteLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const createInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      const response = await fetch("/api/workspaces/invites", { method: "POST" });
      const data = (await response.json().catch(() => null)) as
        | { url?: string; expiresAt?: string; error?: string }
        | null;
      if (!response.ok || !data?.url || !data.expiresAt) {
        toast.error(data?.error ?? "Couldn't create an invite link.");
        return;
      }
      setFreshUrl(data.url);
      setInvite({ expiresAt: data.expiresAt, createdAt: new Date().toISOString() });
      toast.success("Invite link created.");
    } catch {
      toast.error("Couldn't create an invite link.");
    } finally {
      setInviteBusy(false);
    }
  }, [toast]);

  // ConfirmDialog contract: throw to keep the dialog open on failure (the
  // error is already surfaced via toast here).
  const revokeInvite = useCallback(async () => {
    const response = await fetch("/api/workspaces/invites", { method: "DELETE" });
    if (!response.ok) {
      toast.error("Couldn't revoke the invite link.");
      throw new Error("REVOKE_FAILED");
    }
    setInvite(null);
    setFreshUrl(null);
    toast.success("Invite link revoked.");
  }, [toast]);

  async function copyInviteUrl() {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
      toast.success("Invite link copied.");
    } catch {
      toast.error("Couldn't copy the link. Copy it manually instead.");
    }
  }

  // --- Members (GET /api/workspaces/members, DELETE .../[userId]) ---
  const [members, setMembers] = useState<Member[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/workspaces/members");
        const data = (await response.json().catch(() => null)) as { members: Member[] } | null;
        if (!cancelled) {
          if (response.ok && data) {
            setMembers(data.members);
          } else {
            setMembersError(true);
          }
        }
      } catch {
        if (!cancelled) setMembersError(true);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ConfirmDialog contract: throw to keep the dialog open on failure.
  const confirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    const response = await fetch(`/api/workspaces/members/${removeTarget.userId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't remove that member.");
      throw new Error("REMOVE_FAILED");
    }
    setMembers((prev) => (prev ? prev.filter((m) => m.userId !== removeTarget.userId) : prev));
    toast.success(`Removed ${removeTarget.name ?? removeTarget.email}.`);
  }, [removeTarget, toast]);

  return (
    <Card className="flex flex-col gap-8 p-6">
      {/* Rename */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="workspace-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className="sm:max-w-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 sm:w-auto"
            loading={savingName}
            disabled={!name.trim() || name.trim() === savedName}
            onClick={handleSaveName}
          >
            {savingName ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Invite link */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Invite link</h3>
        <p className="text-sm text-muted-foreground">
          Share this link so teammates can join and publish to this workspace&apos;s connected
          accounts.
        </p>

        {inviteLoading ? (
          <Skeleton className="mt-1 h-9 w-full max-w-sm" />
        ) : invite ? (
          <div className="mt-2 flex flex-col gap-2">
            {freshUrl ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={freshUrl} className="font-mono text-xs sm:max-w-md" />
                <Button size="sm" variant="outline" className="shrink-0" onClick={copyInviteUrl}>
                  <Copy aria-hidden className="h-4 w-4" />
                  Copy link
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Link created {formatDate(invite.createdAt)} — for security it can&apos;t be shown
                again. Revoke it and create a new one if you&apos;ve lost it.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Expires {formatDate(invite.expiresAt)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" loading={inviteBusy} onClick={createInvite}>
                Create new invite link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setRevokeOpen(true)}
              >
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="outline" loading={inviteBusy} onClick={createInvite}>
              Create invite link
            </Button>
          </div>
        )}
      </div>

      {/* Members */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Members</h3>
        {membersLoading ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : membersError ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load members. Try reloading the page.
          </p>
        ) : members && members.length > 0 ? (
          <ul className="divide-y divide-border">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {member.name ?? member.email}
                  </p>
                  {member.name ? (
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                    {member.role === "owner" ? "Owner" : "Member"}
                  </Badge>
                  {/* v1 has no ownership transfer (design §10): the caller is
                      always the sole owner, so hiding Remove for owner-role
                      rows both keeps an owner from ever seeing a dead-end
                      "remove yourself" control and matches the API's
                      independent "owners can't be removed" guard. */}
                  {member.role !== "owner" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRemoveTarget(member)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        destructive
        title="Revoke this invite link?"
        description="Anyone with the old link will no longer be able to join. You can create a new one anytime."
        confirmText="Revoke"
        onConfirm={revokeInvite}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        destructive
        title={`Remove ${removeTarget?.name ?? removeTarget?.email ?? "this member"}?`}
        description="They'll lose access to this workspace's accounts and posts. Their own account keeps working."
        confirmText="Remove"
        onConfirm={confirmRemove}
      />
    </Card>
  );
}
