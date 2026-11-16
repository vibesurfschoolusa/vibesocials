"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ExternalLink } from "@/components/external-link";
import { SignInAgainLink, useInstalledApp } from "@/components/gbp-sign-in-link";
import { gbpSignInUrl } from "@/lib/gbpSignIn";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { qrSvg } from "@/lib/qrSvg";
import { withWorkspaceId } from "@/lib/workspaceChanged";

/** The message an owner sends a customer to ask for a review; fits any kind of business. */
export function reviewRequestMessage(link: string): string {
  return `Thank you for choosing us! If you have a minute, a quick Google review helps us a lot: ${link}`;
}

export type ReviewLinkState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "none"; reason: string; signIn?: true };

const LOAD_FAILED = "Couldn't load your review link. Reload this page to try again.";

/**
 * The "Get more reviews" panel (2026-11-10): the workspace's Google review link,
 * its QR code, a printable card and a message to send a customer. The link
 * comes from GET /api/reviews/link, which asks Google only while none is saved.
 */
export function ReviewLinkPanel({
  workspaceId,
  isMember,
  signInShownAbove = false,
}: {
  workspaceId: string;
  isMember: boolean;
  /** R25 lead review: the page's error card already offers the sign-in, so this panel adds no second button. */
  signInShownAbove?: boolean;
}) {
  const [state, setState] = useState<ReviewLinkState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reviews/link");
        const body = (await response.json().catch(() => null)) as
          | { url?: unknown; reason?: unknown; signIn?: unknown }
          | null;
        if (cancelled) return;
        if (response.ok && typeof body?.url === "string") {
          setState({ status: "ready", url: body.url });
        } else {
          const reason = typeof body?.reason === "string" ? body.reason : LOAD_FAILED;
          // JJ3 lead review: the route only says an owner should sign in again;
          // the link is built from this page's workspace (lib/gbpSignIn.ts).
          setState(body?.signIn === true ? { status: "none", reason, signIn: true } : { status: "none", reason });
        }
      } catch {
        if (!cancelled) setState({ status: "none", reason: LOAD_FAILED });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ReviewLinkPanelView state={state} workspaceId={workspaceId} isMember={isMember} signInShownAbove={signInShownAbove} />
  );
}

/**
 * "Print card" follows the sign-in link's rule (LL2 second review): in the
 * installed app a new tab opens the browser, where iOS has no session and the
 * card sends to Log in, so there it opens in the same view (the card page has
 * the app's own navigation back); in a browser tab it opens a new one and says so.
 * R27 security-billing L2: it names the page's workspace, which the card page
 * checks against the active one, so it never prints another workspace's card.
 */
export function PrintCardLinkView({ installed, workspaceId }: { installed: boolean; workspaceId: string }) {
  const className = buttonVariants({ variant: "outline", size: "sm" });
  const href = withWorkspaceId("/reviews/print-card", workspaceId);
  if (installed) {
    return (
      <Link href={href} className={className}>
        Print card
      </Link>
    );
  }
  return (
    <ExternalLink href={href} className={className}>
      Print card
    </ExternalLink>
  );
}

function PrintCardLink({ workspaceId }: { workspaceId: string }) {
  return <PrintCardLinkView installed={useInstalledApp()} workspaceId={workspaceId} />;
}

/** The panel for a given state; separate so it renders in tests without a fetch. */
export function ReviewLinkPanelView({
  state,
  workspaceId,
  isMember,
  signInShownAbove = false,
}: {
  state: ReviewLinkState;
  workspaceId: string;
  /** The page's own role: a member never gets the sign-in link (as error-state.tsx). */
  isMember: boolean;
  /** The page's error card already shows the sign-in: one button per page. */
  signInShownAbove?: boolean;
}) {
  const toast = useToast();

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch {
      toast.error(`Couldn't copy the ${what.toLowerCase()}. Select it and copy it yourself.`);
    }
  };

  return (
    <Card className="mt-8 p-6">
      <h2 className="text-base font-semibold text-foreground">Get more reviews</h2>
      {state.status === "loading" ? (
        <div className="mt-4" aria-hidden>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : state.status === "none" ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{state.reason}</p>
          {state.signIn && !isMember && !signInShownAbove ? (
            <div className="mt-3">
              <SignInAgainLink href={gbpSignInUrl(workspaceId)} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-6 sm:flex-row">
          <div
            className="h-36 w-36 shrink-0 rounded-[var(--radius)] border border-border bg-white p-1"
            // Built by qrSvg from the link: numbers and fixed markup only.
            dangerouslySetInnerHTML={{ __html: qrSvg(state.url) }}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Your Google review link</span>
              {/* R26 pages L6: both new-tab links show the shared visible hint in their text. */}
              {/* The hint doesn't inherit break-all: it breaks only between words. */}
              <ExternalLink
                href={state.url}
                className="break-all text-sm text-primary underline-offset-4 hover:underline"
                hintClassName="break-normal"
              >
                {state.url}
              </ExternalLink>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => copy(state.url, "Link")}>
                  Copy link
                </Button>
                <PrintCardLink workspaceId={workspaceId} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Message to send a customer</span>
              <p className="rounded-[var(--radius)] border border-border bg-muted/50 p-3 text-sm text-foreground break-words">
                {reviewRequestMessage(state.url)}
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy(reviewRequestMessage(state.url), "Message")}
                >
                  Copy message
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
