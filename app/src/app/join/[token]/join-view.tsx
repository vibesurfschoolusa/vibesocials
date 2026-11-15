"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/** GET /api/invites/[token] preview shape. 404 (invalid/expired/revoked) is handled separately. */
interface InvitePreview {
  workspaceName: string;
  alreadyMember: boolean;
}

export type InviteLoad =
  | { kind: "ok"; preview: InvitePreview }
  | { kind: "invalid"; message?: string }
  | { kind: "unreachable" };

/** The dead-link state, with the 404 body's sentence when it has one (R10-pages L3). */
async function invalidFrom(response: Response): Promise<{ kind: "invalid"; message?: string }> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : undefined;
  return message ? { kind: "invalid", message } : { kind: "invalid" };
}

/** What the dead-link page says under its title. */
export const INVALID_INVITE_DESCRIPTION = "Ask the workspace owner for a new link.";

export function invalidInviteDescription(message: string | undefined): string {
  return message ?? INVALID_INVITE_DESCRIPTION;
}

/**
 * Reads the invite preview. Only a 404 means the link is dead (the uniform
 * shape for invalid, expired or revoked: no oracle beyond validity). No
 * network, a server failure or too many tries is "unreachable": the link may
 * be fine, so the page offers Try again instead of calling it invalid
 * (R5 pages L7).
 */
export async function loadInvite(fetchImpl: typeof fetch, token: string): Promise<InviteLoad> {
  try {
    const response = await fetchImpl(`/api/invites/${token}`);
    if (response.status === 404) return await invalidFrom(response);
    if (!response.ok) return { kind: "unreachable" };
    return { kind: "ok", preview: (await response.json()) as InvitePreview };
  } catch {
    return { kind: "unreachable" };
  }
}

/** R5 pages L8: what the page says when Join didn't work. */
export const JOIN_FAILED_MESSAGE = "You weren't added to the workspace. Please press Join workspace again in a minute.";
export const JOIN_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so you weren't added. Check your internet connection and press Join workspace again.";

export type AcceptOutcome = { kind: "joined" } | { kind: "invalid"; message?: string } | { kind: "failed"; message: string };

/**
 * Join. A 404 means the invite died (expired, revoked, or its maker is no
 * longer an owner) between the preview and the click: the page shows the same
 * dead-link state as the preview rather than a dead-end toast.
 */
export async function acceptInvite(fetchImpl: typeof fetch, token: string): Promise<AcceptOutcome> {
  try {
    const response = await fetchImpl(`/api/invites/${token}/accept`, { method: "POST" });
    if (response.ok) return { kind: "joined" };
    if (response.status === 404) return await invalidFrom(response);
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { kind: "failed", message: typeof data?.error === "string" && data.error ? data.error : JOIN_FAILED_MESSAGE };
  } catch {
    return { kind: "failed", message: JOIN_OFFLINE_MESSAGE };
  }
}

/**
 * R6-pages L4: what joining lets a member do. Invites add members, and a
 * member's posts wait for an owner when the workspace asks for approval.
 */
export function joinPromise(requiresApproval: boolean): string {
  return requiresApproval
    ? "You'll be able to create posts for this workspace's connected accounts. An owner approves each post before it goes out."
    : "You'll be able to publish to this workspace's connected accounts.";
}

/**
 * Client-rendered join flow. The parent server component gates sign-in and
 * reads whether the workspace asks for approval.
 */
export function JoinView({ token, requiresApproval = false }: { token: string; requiresApproval?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [load, setLoad] = useState<InviteLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadInvite(fetch, token).then((result) => {
      if (!cancelled) setLoad(result);
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const preview = load?.kind === "ok" ? load.preview : null;

  async function handleJoin() {
    setJoining(true);
    const outcome = await acceptInvite(fetch, token);
    setJoining(false);
    if (outcome.kind === "invalid") {
      setLoad(outcome);
      return;
    }
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    toast.success(`Joined ${preview?.workspaceName ?? "the workspace"}.`);
    router.push("/");
  }

  if (!load) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (load.kind === "unreachable") {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <EmptyState
          icon={<UserPlus />}
          title="We couldn't load this invite."
          description="The link may be fine. Check your internet connection, then press Try again."
          action={
            <Button
              onClick={() => {
                setLoad(null);
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <EmptyState
          icon={<UserPlus />}
          title="This invite link isn't valid anymore."
          description={invalidInviteDescription(load.kind === "invalid" ? load.message : undefined)}
          action={
            <Link href="/" className={buttonVariants({ variant: "primary" })}>
              Go to dashboard
            </Link>
          }
        />
      </div>
    );
  }

  if (preview.alreadyMember) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            You&apos;re already in {preview.workspaceName}
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;re already a member of this workspace.
          </p>
          <Link href="/" className={buttonVariants({ variant: "primary", className: "mt-2" })}>
            Go to dashboard
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card className="flex flex-col items-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">Join {preview.workspaceName}?</h1>
        <p className="text-sm text-muted-foreground">{joinPromise(requiresApproval)}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button onClick={handleJoin} loading={joining}>
            {joining ? "Joining…" : "Join workspace"}
          </Button>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Cancel
          </Link>
        </div>
      </Card>
    </div>
  );
}
