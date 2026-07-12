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

/** Client-rendered join flow. The parent server component gates sign-in. */
export function JoinView({ token }: { token: string }) {
  const router = useRouter();
  const toast = useToast();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/invites/${token}`);
        if (!response.ok) {
          // 404 is the uniform shape for invalid/expired/revoked (no oracle
          // beyond validity) — render the one generic error state either way.
          if (!cancelled) setInvalid(true);
          return;
        }
        const data: InvitePreview = await response.json();
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setInvalid(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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
          setInvalid(true);
          return;
        }
        toast.error(data?.error ?? "Couldn't join this workspace.");
        return;
      }
      toast.success(`Joined ${preview?.workspaceName ?? "the workspace"}.`);
      router.push("/");
    } catch {
      toast.error("Couldn't join this workspace.");
    } finally {
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (invalid || !preview) {
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
