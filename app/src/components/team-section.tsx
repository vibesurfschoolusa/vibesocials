"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Copy } from "lucide-react";
import type { WorkspaceRole } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { afterWorkspaceChange } from "@/lib/afterWorkspaceChange";
import { formatDisplayDate } from "@/lib/displayDate";
import { memberRemovalOutcome, type MemberRemovalOutcome } from "@/lib/memberRemoval";
import { PAID_PLAN_WORKSPACE_DELETE_SENTENCE } from "@/lib/planCopy";
import { personLabel } from "@/lib/usageLimits";
import { announceWorkspaceChange } from "@/lib/workspaceChangeEvent";

import { FormError } from "./account-section";
import { announceClientLinksReplaced, subscribeClientLinksReplaced } from "./client-links-refresh";

/** GET /api/workspaces/members list item — owner-only route (SEC-1: never fetched for a member). */
interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

/**
 * A Team card row (owners' view): the one label rule (personLabel, owner
 * reader), so a blank or spaces-only name shows the address, and the address
 * goes under a real name only.
 */
export function teamMemberLines(member: Pick<Member, "name" | "email">): { label: string; email: string | null } {
  return { label: personLabel(member, true), email: member.name?.trim() ? member.email : null };
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
  return formatDisplayDate(date);
}

/** Computed on the server for owners: what deleting this workspace would remove. */
export interface WorkspaceDeletionInfo {
  memberCount: number;
  scheduledCount: number;
  /** The sentence the server would refuse with, or null when it is allowed. */
  refusal: string | null;
  /** S1: deleting cancels a paid plan (app/settings/paidPlans.ts). */
  paidPlan?: boolean;
}

interface TeamSectionProps {
  /**
   * The workspace this page was rendered for (F3). Rename, delete and the
   * invite link send it, and the routes refuse any other: the active
   * workspace is one cookie every tab shares.
   */
  workspaceId: string;
  role: WorkspaceRole;
  workspaceName: string;
  deletion?: WorkspaceDeletionInfo | null;
}

/**
 * Settings → Team card (design doc §7). Owners get full management (rename,
 * invite link, member list + removal); members get a read-only summary.
 */
/**
 * R5-security L1: the toast after "Make new client links", from POST
 * /api/workspaces/client-links's answer. The upload link is copied on the
 * Media page and the review link on the Queue page; R6 M2: the connect link
 * under Connections (remounted with the new link, client-links-refresh.tsx).
 */
export function clientLinksReplacedMessage(answer: unknown): string {
  const made = (answer ?? {}) as {
    uploadLink?: unknown;
    reviewLink?: unknown;
    connectLink?: unknown;
    connectLinkTurnedOff?: unknown;
  };
  const places = [
    made.uploadLink ? { name: "upload", where: "on the Media page" } : null,
    made.reviewLink ? { name: "review", where: "on the Queue page" } : null,
    made.connectLink ? { name: "connect", where: "under Connections" } : null,
  ].filter((place): place is { name: string; where: string } => place !== null);

  const sentences: string[] = [];
  if (places.length > 1) {
    const parts = places.map((place) => `the ${place.name} link ${place.where}`);
    sentences.push(
      `New client links are on and the old ones no longer work. Copy ${listOf(parts)}, and send them to your client.`,
    );
  } else if (places.length === 1) {
    const [place] = places;
    sentences.push(
      `A new client ${place.name} link is on and the old one no longer works. Copy it ${place.where} and send it to your client.`,
    );
  }
  if (made.connectLinkTurnedOff === true) {
    sentences.push(
      "The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
  }
  return sentences.length > 0 ? sentences.join(" ") : "No client link was on, so there was nothing to replace.";
}

function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** GET /api/workspaces/client-links: which client links are on, and whether the plan includes them. */
export interface ClientLinksState {
  included: boolean;
  on: { upload: boolean; review: boolean; connect: boolean };
  /** The connect link is on, but its maker is no longer an owner: it works for nobody. */
  connectStopped: boolean;
  /**
   * R22 client-journey L1: the workspace is blocked (paused, or an ended trial
   * or plan), so no client link works and none can be made; the panel's sentence.
   */
  workspaceBlocked?: string;
}

/**
 * The toast after a demotion, from the links' state read after it (Check 4):
 * it names only the links that still work, says when the connect link has
 * stopped, and points to the button. R6-client-journey L3: after demoting
 * yourself only "Role updated.", as the button went with your ownership.
 */
/**
 * R9-client-journey L1: a demotion turns off the invite links the demoted
 * owner made (PATCH answers `joinLinksRevoked`). There is one active link per
 * workspace, so any turned off is the one the card shows: it goes, as on removal.
 */
export function demotionOutcome(body: unknown): MemberRemovalOutcome {
  const revoked =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { joinLinksRevoked?: unknown }).joinLinksRevoked
      : undefined;
  return memberRemovalOutcome({ invitesRevoked: revoked });
}

export function demotedMessage(links: ClientLinksState | null, self = false): string {
  if (self || !links) return "Role updated.";
  if (links.workspaceBlocked) return blockedDemotedMessage(links, links.workspaceBlocked);
  if (!links.included) return "Role updated.";
  const working = [
    links.on.upload ? "upload" : null,
    links.on.review ? "review" : null,
    links.on.connect && !links.connectStopped ? "connect" : null,
  ].filter((name): name is string => name !== null);
  const stopped = links.on.connect && links.connectStopped;
  if (working.length === 0 && !stopped) return "Role updated.";

  const sentences = ["Role updated."];
  if (working.length > 0) {
    sentences.push(
      working.length > 1
        ? `They could copy the client ${listOf(working)} links, which still work.`
        : `They could copy the client ${working[0]} link, which still works.`,
    );
  }
  if (stopped) {
    sentences.push(
      "The client connect link has stopped working, because the owner who made it is no longer an owner.",
    );
  }
  const replaced = working.length + (stopped ? 1 : 0);
  sentences.push(
    working.length === 0
      ? "Press Make new client links below to give your client a new one."
      : `Press Make new client links below to replace ${replaced > 1 ? "them" : "it"}.`,
  );
  return sentences.join(" ");
}

/**
 * R22 client-journey L1: while blocked, none of the links works, but the copies
 * the former owner kept work again when the block ends; new ones can't be made,
 * so the toast points to Turn off. A stopped connect link alone leaves nothing
 * to turn off (as on a plan without client links).
 */
function blockedDemotedMessage(links: ClientLinksState, blocked: string): string {
  const held = [
    links.on.upload ? "upload" : null,
    links.on.review ? "review" : null,
    links.on.connect && !links.connectStopped ? "connect" : null,
  ].filter((name): name is string => name !== null);
  if (held.length === 0) return "Role updated.";
  const one = held.length === 1;
  return [
    "Role updated.",
    one ? `They could copy the client ${held[0]} link.` : `They could copy the client ${listOf(held)} links.`,
    blocked,
    one ? "The copy they kept will work again once the workspace is active again." : "The copies they kept will work again once the workspace is active again.",
    "Press Turn off client links below to stop that.",
  ].join(" ");
}

/** R6 L2: the button is offered only with something to replace, on a plan that includes client links. */
export function clientLinksButtonShown(state: ClientLinksState | null): boolean {
  return !!state && !state.workspaceBlocked && state.included && (state.on.upload || state.on.review || state.on.connect);
}

/**
 * R7-pages L3: on a plan without client links they are paused, not off, and
 * a replace is refused; "Turn off client links" is offered instead while one
 * is on, so a former owner's copies can't come back with the plan.
 */
export function clientLinksTurnOffShown(state: ClientLinksState | null): boolean {
  return !!state && (!!state.workspaceBlocked || !state.included) && (state.on.upload || state.on.review || state.on.connect);
}

/** The links' state, or null when it can't be read (no button then). */
async function fetchClientLinks(workspaceId: string, fetchImpl: typeof fetch = fetch): Promise<ClientLinksState | null> {
  try {
    const response = await fetchImpl(`/api/workspaces/client-links?workspaceId=${encodeURIComponent(workspaceId)}`);
    const data = (await response.json().catch(() => null)) as ClientLinksState | null;
    return response.ok && data?.on ? data : null;
  } catch {
    return null;
  }
}

export { CLIENT_LINKS_REPLACED_EVENT } from "./client-links-refresh";

/**
 * R6 review low 2: reads the links' state again each time the connect link
 * card on this page makes, replaces or turns off its link, so the button shows
 * or hides without a reload. Its own replace is not read again: the answer
 * already says what is on. Answers the unsubscribe.
 */
export function watchClientLinks(
  workspaceId: string,
  onState: (state: ClientLinksState | null) => void,
  fetchImpl: typeof fetch = fetch,
): () => void {
  return subscribeClientLinksReplaced((source) => {
    if (source !== "connect-link") return;
    void fetchClientLinks(workspaceId, fetchImpl).then(onState);
  });
}

/**
 * POST /api/workspaces/client-links. Answers the route's answer, after
 * `announce` (Check 3: the connect link card on this page reads its new link);
 * throws an Error whose message the person can act on, announcing nothing.
 */
export async function requestClientLinksReplace(
  fetchImpl: typeof fetch,
  workspaceId: string,
  announce: () => void = announceClientLinksReplaced,
): Promise<{ uploadLink?: unknown; reviewLink?: unknown; connectLink?: unknown; connectLinkTurnedOff?: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl("/api/workspaces/client-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
  } catch {
    throw new Error("Couldn't reach the server. The old client links still work. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : "Couldn't make new client links. The old ones still work. Try again.",
    );
  }
  announce();
  return data ?? {};
}

/**
 * DELETE /api/workspaces/client-links: turns every client link off, on any
 * plan. Then `announce`, as after a replace; throws an Error whose message
 * the person can act on, announcing nothing.
 */
export async function requestClientLinksTurnOff(
  fetchImpl: typeof fetch,
  workspaceId: string,
  announce: () => void = announceClientLinksReplaced,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl("/api/workspaces/client-links", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
  } catch {
    throw new Error("Couldn't reach the server. The client links are unchanged. Check your connection and try again.");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    throw new Error(
      typeof data?.error === "string" ? data.error : "Couldn't turn off the client links. Nothing changed. Try again.",
    );
  }
  announce();
}

/**
 * The Client links block of the owners' Team card. "Make new client links"
 * asks first (R6 L2); on a plan without client links "Turn off client
 * links" does (R7-pages L3). `onReplace` and `onTurnOff` follow the
 * ConfirmDialog contract: they throw to keep the dialog open.
 */
export function ClientLinksPanel({
  state,
  onReplace,
  onTurnOff,
}: {
  state: ClientLinksState | null;
  onReplace: () => Promise<void>;
  onTurnOff: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (clientLinksTurnOffShown(state)) {
    const blocked = state?.workspaceBlocked;
    return (
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Client links</h3>
        {blocked ? (
          <p className="text-sm text-muted-foreground">
            {blocked} Copies kept by someone who stopped being an owner will work again once the workspace is active again. Turning
            them off stops that.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Client links are paused, because this workspace&apos;s plan doesn&apos;t include them. Copies kept by
            someone who stopped being an owner would work again if the plan changes to one with client links. Turning
            them off stops that.
          </p>
        )}
        <div>
          <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
            Turn off client links
          </Button>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          destructive
          title="Turn off client links?"
          description={`The client upload, review and connect links stop working for good, including any copies a former owner kept. You can make new ones ${blocked ? "once client links work again" : "on a plan with client links"}.`}
          confirmText="Turn off"
          onConfirm={onTurnOff}
        />
      </div>
    );
  }
  if (!clientLinksButtonShown(state)) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-6">
      <h3 className="text-sm font-medium text-foreground">Client links</h3>
      <p className="text-sm text-muted-foreground">
        Someone who stops being an owner can still use the client upload, review and connect links they copied. New
        links stop the old ones working.
      </p>
      <div>
        <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
          Make new client links
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        destructive
        title="Make new client links?"
        description="The client links that are on stop working, including any copies a former owner kept. Send your client the new ones afterwards."
        confirmText="Make new links"
        onConfirm={onReplace}
      />
    </div>
  );
}

export function TeamSection({ workspaceId, role, workspaceName, deletion }: TeamSectionProps) {
  if (role !== "owner") {
    return <MemberView workspaceId={workspaceId} workspaceName={workspaceName} />;
  }
  return <OwnerView workspaceId={workspaceId} workspaceName={workspaceName} deletion={deletion ?? null} />;
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
function MemberView({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
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
    const response = await fetch("/api/workspaces/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't leave the workspace.");
      throw new Error("LEAVE_FAILED");
    }
    toast.success("Left the workspace.");
    // The route moved the active workspace; R15: a full load of this page, so the
    // top bar and the banner (read once per page load) follow it.
    afterWorkspaceChange();
  }, [toast, workspaceId]);

  return (
    <Card className="p-6">
      <h3 className="text-base font-semibold text-foreground">{workspaceName}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Only the workspace owner can manage members.
      </p>

      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
        <h4 className="text-sm font-medium text-foreground">Members</h4>
        {rosterLoading ? (
          <>
            <p role="status" className="sr-only">Loading members…</p>
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </>
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

function OwnerView({
  workspaceId,
  workspaceName,
  deletion,
}: {
  workspaceId: string;
  workspaceName: string;
  deletion: WorkspaceDeletionInfo | null;
}) {
  const router = useRouter();
  const toast = useToast();
  // Own user id — next-auth populates `session.user.id` via the jwt/session
  // callbacks (lib/auth.ts), typed loosely there so cast here too. Used only to
  // tell a SELF-demotion (owner steps down to member) from demoting another
  // owner: the former must re-render the whole card as MemberView.
  const { data: session } = useSession();
  const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? null;

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
        body: JSON.stringify({ name: trimmed, workspaceId }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Couldn't rename workspace.");
        return;
      }
      setSavedName(trimmed);
      setName(trimmed);
      toast.success("Workspace renamed.");
      // R16 L1: the active workspace stays, so no full load, which threw away
      // unsaved typing on Settings and a freshly shown invite or connect link.
      // The server parts re-render; the account menu hears the announce and
      // reads the new name.
      router.refresh();
      announceWorkspaceChange();
    } catch {
      toast.error("Couldn't rename workspace.");
    } finally {
      setSavingName(false);
    }
  }, [name, router, savedName, toast, workspaceId]);

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
      const response = await fetch("/api/workspaces/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
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
  }, [toast, workspaceId]);

  // ConfirmDialog contract: throw to keep the dialog open on failure (the
  // error is already surfaced via toast here).
  const revokeInvite = useCallback(async () => {
    const response = await fetch("/api/workspaces/invites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      // A 409 says another tab switched workspace; show the route's sentence.
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't revoke the invite link.");
      throw new Error("REVOKE_FAILED");
    }
    setInvite(null);
    setFreshUrl(null);
    toast.success("Invite link revoked.");
  }, [toast, workspaceId]);

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
  const [promoteTarget, setPromoteTarget] = useState<Member | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<Member | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [clientLinks, setClientLinks] = useState<ClientLinksState | null>(null);

  // R6 L2: whether "Make new client links" has anything to replace. When it
  // can't be read there is no button; each link's own Replace still works.
  useEffect(() => {
    let cancelled = false;
    const show = (state: ClientLinksState | null) => {
      if (!cancelled) setClientLinks(state);
    };
    void fetchClientLinks(workspaceId).then(show);
    const stop = watchClientLinks(workspaceId, show);
    return () => {
      cancelled = true;
      stop();
    };
  }, [workspaceId]);

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't remove that member.");
      throw new Error("REMOVE_FAILED");
    }
    setMembers((prev) => (prev ? prev.filter((m) => m.userId !== removeTarget.userId) : prev));
    toast.success(`Removed ${personLabel(removeTarget, true)}.`);

    // The server revokes the workspace's active invite links on removal (so the
    // removed member can't rejoin with the link they hold): drop the link we're
    // displaying — it's dead — and tell the owner to create a fresh one.
    const outcome = memberRemovalOutcome(await response.json().catch(() => null));
    if (outcome.clearInvite) {
      setInvite(null);
      setFreshUrl(null);
    }
    if (outcome.notice) {
      toast.info(outcome.notice);
    }
  }, [removeTarget, toast, workspaceId]);

  // ConfirmDialog contract: throw to keep the dialog open on failure. Promote
  // member -> owner only ever ADDS an owner, so patch local state in place
  // (never a self-transition out of OwnerView — the caller's own row is an
  // owner row, which shows "Make member", not "Make owner").
  const confirmPromote = useCallback(async () => {
    if (!promoteTarget) return;
    const response = await fetch(`/api/workspaces/members/${promoteTarget.userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "owner", workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't update that member's role.");
      throw new Error("PROMOTE_FAILED");
    }
    setMembers((prev) =>
      prev
        ? prev.map((m): Member => (m.userId === promoteTarget.userId ? { ...m, role: "owner" } : m))
        : prev,
    );
    toast.success("Role updated.");
  }, [promoteTarget, toast, workspaceId]);

  // ConfirmDialog contract: throw to keep the dialog open on failure. Demote
  // owner -> member. Demoting YOURSELF drops you out of OwnerView, so on that
  // branch refresh the route (the server now resolves role="member" and the
  // card re-renders as MemberView) instead of patching local state, and
  // announce it for the top bar. The server enforces the >=1-owner invariant, so a
  // last-owner demote is refused there and surfaced via toast.
  const confirmDemote = useCallback(async () => {
    if (!demoteTarget) return;
    const response = await fetch(`/api/workspaces/members/${demoteTarget.userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member", workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't update that member's role.");
      throw new Error("DEMOTE_FAILED");
    }
    if (demoteTarget.userId === currentUserId) {
      toast.success(demotedMessage(null, true));
      router.refresh();
      // R16 L2: the banner reads its status again, so the owner-only trial and
      // plan line goes; the menu reads the new role.
      announceWorkspaceChange();
      return;
    }
    const revoked = demotionOutcome(await response.json().catch(() => null));
    if (revoked.clearInvite) {
      setInvite(null);
      setFreshUrl(null);
    }
    // Check 4: read the links after the demotion, so the toast names only the
    // ones that really still work (a connect link they made has stopped).
    const links = await fetchClientLinks(workspaceId);
    if (links) setClientLinks(links);
    toast.success(demotedMessage(links));
    if (revoked.notice) toast.info(revoked.notice);
    setMembers((prev) =>
      prev
        ? prev.map((m): Member => (m.userId === demoteTarget.userId ? { ...m, role: "member" } : m))
        : prev,
    );
  }, [demoteTarget, currentUserId, router, toast, workspaceId]);

  // R5-security L1: one press, after a confirm (R6 L2), replaces every client
  // link that is on. ConfirmDialog contract: throw to keep the dialog open.
  const replaceClientLinks = useCallback(async () => {
    let made;
    try {
      made = await requestClientLinksReplace(fetch, workspaceId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't make new client links. The old ones still work. Try again.");
      throw error;
    }
    setClientLinks((prev) =>
      prev
        ? {
            ...prev,
            on: { upload: !!made.uploadLink, review: !!made.reviewLink, connect: !!made.connectLink },
            connectStopped: false,
          }
        : prev,
    );
    toast.success(clientLinksReplacedMessage(made));
  }, [toast, workspaceId]);

  // R7-pages L3: on a plan without client links, turns them all off instead.
  const turnOffClientLinks = useCallback(async () => {
    try {
      await requestClientLinksTurnOff(fetch, workspaceId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't turn off the client links. Nothing changed. Try again.");
      throw error;
    }
    setClientLinks((prev) =>
      prev ? { ...prev, on: { upload: false, review: false, connect: false }, connectStopped: false } : prev,
    );
    toast.success("Client links are off. Nobody can use the old ones, even if the plan changes.");
  }, [toast, workspaceId]);

  // ConfirmDialog contract: throw to keep the dialog open on failure. Verbatim
  // MemberView.handleLeave — an owner may leave once another owner remains (the
  // Leave control is disabled below until then; the server backstops with a
  // 400 either way).
  const handleLeave = useCallback(async () => {
    const response = await fetch("/api/workspaces/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't leave the workspace.");
      throw new Error("LEAVE_FAILED");
    }
    toast.success("Left the workspace.");
    // The route moved the active workspace; R15: a full load of this page, so the
    // top bar and the banner (read once per page load) follow it.
    afterWorkspaceChange();
  }, [toast, workspaceId]);

  // Derived from the loaded roster each render, so it stays fresh after every
  // local-state role change above. Gates the last-owner demote/leave guards.
  const ownerCount = members?.filter((m) => m.role === "owner").length ?? 0;

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
          <>
            <p role="status" className="sr-only">Loading invite link…</p>
            <Skeleton className="mt-1 h-9 w-full max-w-sm" />
          </>
        ) : invite ? (
          <div className="mt-2 flex flex-col gap-2">
            {freshUrl ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input readOnly value={freshUrl} aria-label="New invite link" className="font-mono text-xs sm:max-w-md" />
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
          <>
            <p role="status" className="sr-only">Loading members…</p>
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </>
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
                    {teamMemberLines(member).label}
                  </p>
                  {teamMemberLines(member).email ? (
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                    {member.role === "owner" ? "Owner" : "Member"}
                  </Badge>
                  {/* Owners are demoted, not removed: removing a co-owner is
                      the demote-then-remove flow the DELETE route guards for (it
                      refuses owner-role targets), so an owner row shows "Make
                      member" instead of "Remove". Disabled for the last
                      remaining owner — the server enforces the same >=1-owner
                      invariant with a 400. */}
                  {member.role === "owner" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={ownerCount < 2}
                      title={ownerCount < 2 ? "Promote another owner first." : undefined}
                      onClick={() => setDemoteTarget(member)}
                    >
                      Make member
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setPromoteTarget(member)}>
                        Make owner
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setRemoveTarget(member)}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* R5-security L1 / R6 M2: a former owner's copies of the client links keep working until these are replaced. */}
      <ClientLinksPanel state={clientLinks} onReplace={replaceClientLinks} onTurnOff={turnOffClientLinks} />

      {/* Leave — an owner may step down once another owner exists. Disabled
          with an explanation until then (the server backstops with a 400). */}
      <div className="border-t border-border pt-6">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={ownerCount < 2}
          onClick={() => setLeaveOpen(true)}
        >
          Leave workspace
        </Button>
        {ownerCount < 2 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            You&apos;re the only owner — promote someone first.
          </p>
        ) : null}
      </div>

      {deletion ? <DeleteWorkspace workspaceId={workspaceId} workspaceName={savedName} deletion={deletion} /> : null}

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
        title={`Remove ${removeTarget ? personLabel(removeTarget, true) : "this member"}?`}
        description="They'll lose access to this workspace's accounts and posts. Their own account keeps working."
        confirmText="Remove"
        onConfirm={confirmRemove}
      />

      <ConfirmDialog
        open={promoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPromoteTarget(null);
        }}
        title={`Make ${promoteTarget ? personLabel(promoteTarget, true) : "this member"} an owner?`}
        description="They'll be able to manage members, connections, and settings."
        confirmText="Make owner"
        onConfirm={confirmPromote}
      />

      <ConfirmDialog
        open={demoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDemoteTarget(null);
        }}
        destructive
        title={`Make ${demoteTarget ? personLabel(demoteTarget, true) : "this member"} a member?`}
        description="They'll no longer manage members, connections, or settings."
        confirmText="Make member"
        onConfirm={confirmDemote}
      />

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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Owner-only "Delete this workspace". The confirm button is replaced by the
 * server's refusal sentence when one applies; otherwise the owner must type
 * the workspace name exactly, as DELETE /api/workspaces/active requires.
 * R7-pages L6: its error is announced (FormError, role="alert").
 */
export function DeleteWorkspace({
  workspaceId,
  workspaceName,
  deletion,
}: {
  workspaceId: string;
  workspaceName: string;
  deletion: WorkspaceDeletionInfo;
}) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces/active", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName, workspaceId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not delete this workspace. Try again.");
        setBusy(false);
        return;
      }
      // The route cleared the active-workspace cookie. R14-client-journey L1: a
      // full load, so the server and the account menu (which reads its
      // workspaces once per page load) re-resolve it; a client navigation left
      // the menu naming the deleted workspace. `busy` stays set while the page
      // unloads.
      afterWorkspaceChange("/");
    } catch {
      setError("Could not delete this workspace. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-6">
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Delete this workspace
      </Button>

      <Dialog open={open} onOpenChange={busy ? () => undefined : setOpen}>
        <DialogHeader>
          <DialogTitle>Delete {workspaceName}?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <p>
            {/* memberCount includes the owner, so 1 means nobody else is affected. */}
            {deletion.memberCount > 1
              ? `This removes the workspace for all ${deletion.memberCount} members, with its connections, media, posts and stats.`
              : "This removes the workspace with its connections, media, posts and stats."}{" "}
            {deletion.scheduledCount === 0
              ? "It has no scheduled posts."
              : `${plural(deletion.scheduledCount, "scheduled post", "scheduled posts")} will not go out.`}
          </p>
          <p>
            Connected platform accounts keep any access they granted until it is removed on each
            platform.
          </p>
          {deletion.paidPlan ? <p>{PAID_PLAN_WORKSPACE_DELETE_SENTENCE}</p> : null}
          {deletion.refusal ? (
            <Alert variant="danger">{deletion.refusal}</Alert>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-workspace-confirm">
                Type <strong>{workspaceName}</strong> to confirm
              </Label>
              <Input
                id="delete-workspace-confirm"
                autoComplete="off"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
              />
            </div>
          )}
          {error ? <FormError message={error} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {deletion.refusal ? null : (
            <Button
              variant="destructive"
              loading={busy}
              disabled={confirmName !== workspaceName}
              onClick={handleDelete}
            >
              Delete workspace
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </div>
  );
}
