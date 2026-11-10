"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { qrSvg } from "@/lib/qrSvg";

/** The message an owner sends a customer to ask for a review. */
export function reviewRequestMessage(link: string): string {
  return `Thanks for coming out with us! If you have a minute, a quick Google review helps us a lot: ${link}`;
}

export type ReviewLinkState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "none"; reason: string };

const LOAD_FAILED = "Couldn't load your review link. Reload this page to try again.";

/**
 * The "Get more reviews" panel (2026-11-10): the workspace's Google review link,
 * its QR code, a printable card and a message to send a customer. The link
 * comes from GET /api/reviews/link, which asks Google only while none is saved.
 */
export function ReviewLinkPanel() {
  const [state, setState] = useState<ReviewLinkState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reviews/link");
        const body = (await response.json().catch(() => null)) as { url?: unknown; reason?: unknown } | null;
        if (cancelled) return;
        if (response.ok && typeof body?.url === "string") {
          setState({ status: "ready", url: body.url });
        } else {
          setState({ status: "none", reason: typeof body?.reason === "string" ? body.reason : LOAD_FAILED });
        }
      } catch {
        if (!cancelled) setState({ status: "none", reason: LOAD_FAILED });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <ReviewLinkPanelView state={state} />;
}

/** The panel for a given state; separate so it renders in tests without a fetch. */
export function ReviewLinkPanelView({ state }: { state: ReviewLinkState }) {
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
    <Card className="mb-8 p-6">
      <h2 className="text-base font-semibold text-foreground">Get more reviews</h2>
      {state.status === "loading" ? (
        <div className="mt-4" aria-hidden>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : state.status === "none" ? (
        <p className="mt-2 text-sm text-muted-foreground">{state.reason}</p>
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
              <a
                href={state.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm text-primary underline-offset-4 hover:underline"
              >
                {state.url}
              </a>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => copy(state.url, "Link")}>
                  Copy link
                </Button>
                <Link
                  href="/reviews/print-card"
                  target="_blank"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Print card
                </Link>
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
