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

export type InviteLoad = { kind: "ok"; preview: InvitePreview } | { kind: "invalid" } | { kind: "unreachable" };

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
    if (response.status === 404) return { kind: "invalid" };
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

/** Client-rendered join flow. The parent server component gates sign-in. */
export function JoinView({ token }: { token: string }) {
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
    try {
      const response = await fetch(`/api/invites/${token}/accept`, { method: "POST" });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        // A 404 here means the invite died (expired/revoked) in the window
        // between the preview load and clicking Join — fall back to the same
        // invalid-link state rather than a dead-end toast.
        if (response.status === 404) {
          setLoad({ kind: "invalid" });
          return;
        }
        toast.error(data?.error ?? JOIN_FAILED_MESSAGE);
        return;
      }
      toast.success(`Joined ${preview?.workspaceName ?? "the workspace"}.`);
      router.push("/");
    } catch {
      toast.error(JOIN_OFFLINE_MESSAGE);
    } finally {
      setJoining(false);
    }
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
          description="Ask the workspace owner for a new link."
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
        <p className="text-sm text-muted-foreground">
          You&apos;ll be able to publish to this workspace&apos;s connected accounts.
        </p>
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
