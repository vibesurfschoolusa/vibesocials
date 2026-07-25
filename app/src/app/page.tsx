"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Link2, PenSquare } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Landing } from "@/components/landing";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { ConnectionHealth } from "@/components/dashboard/connection-health";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { YouTubeMetricsSummary } from "@/components/dashboard/youtube-metrics-summary";
import { useConnections } from "@/hooks/useConnections";
import { usePostJobs } from "@/hooks/usePostJobs";
import {
  COMPOSE_CTA,
  deriveDashboardCta,
  deriveGettingStarted,
} from "@/lib/gettingStarted";

export default function HomePage() {
  const { status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner size="lg" label="Loading" className="text-muted-foreground" />
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Landing />;
  }

  return <Dashboard />;
}

function Dashboard() {
  // Task 8 — single fetch/poll owner for the dashboard: both widgets below
  // took this over their own `usePostJobs()` call, so the dashboard makes one
  // `/api/posts` request (and one poll timer) instead of two. Same pattern
  // for connections: this is the one `/api/connections` fetch, shared by the
  // Get started checklist and the ConnectionHealth widget.
  const postJobs = usePostJobs();
  const connectionsState = useConnections();

  // Both derivations are pure and cheap, so each consumer re-derives from the
  // same two fetches rather than threading state through props.
  const onboarding = deriveGettingStarted(
    connectionsState.connections,
    postJobs.jobs,
  );

  // Header state is three-way, not two: "still loading" and "loaded but the
  // fetch failed" both leave the data null, and only the first of them should
  // show a skeleton — otherwise a failed request parks a skeleton on screen
  // permanently. On failure we degrade to the neutral heading and the
  // steady-state CTA rather than asserting anything we can't back up.
  const headerLoading = connectionsState.loading || postJobs.loading;
  const cta = deriveDashboardCta(connectionsState.connections) ?? COMPOSE_CTA;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 lg:px-8">
      {/* The greeting and the CTA read from the same two fetches, so the whole
          header resolves at once. Skeletons until then: a heading that says
          "Welcome back" and then corrects itself to "Welcome to Vibe Socials"
          — or a button whose label swaps under the cursor — is worse than a
          beat of nothing. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {headerLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {/* "Welcome back" is untrue on a first visit, so only greet a
                  return once the account has something in it — and say neither
                  when a failed fetch means we don't know. */}
              {!onboarding.ready
                ? "Dashboard"
                : onboarding.connectDone || onboarding.postDone
                  ? "Welcome back"
                  : "Welcome to Vibe Socials"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {/* Deliberately not "Signed in as {email}": the account menu in
                  the header already shows it, so repeating it here spends the
                  most valuable line on the page saying nothing. */}
              {onboarding.ready && !onboarding.complete
                ? "Publish to every platform you're on, from one place."
                : "Here's a look at your posts."}
            </p>
          </div>
        )}

        {/* One primary action, and only the one that works right now — see
            deriveDashboardCta. */}
        {headerLoading ? (
          <Skeleton className="h-10 w-40 shrink-0" aria-hidden />
        ) : (
          <Link
            href={cta.href}
            className={buttonVariants({ variant: "primary", className: "gap-2" })}
          >
            {cta.kind === "compose" ? (
              <PenSquare aria-hidden className="h-4 w-4" />
            ) : (
              <Link2 aria-hidden className="h-4 w-4" />
            )}
            {cta.label}
          </Link>
        )}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* First-run checklist — renders nothing once the user has a
              connection and a post (see lib/gettingStarted.ts). */}
          <GettingStarted
            connections={connectionsState.connections}
            jobs={postJobs.jobs}
          />
          {/* Roadmap Phase 8 — renders only once a YouTube post has fetched metrics. */}
          <YouTubeMetricsSummary jobs={postJobs.jobs} />
          {/* While the checklist is up it owns the "create your first post"
              instruction; a second copy of it directly below competes with the
              step the user is actually on. */}
          <RecentActivity {...postJobs} showCreateCta={!onboarding.show} />
        </div>
        <div className="space-y-6">
          <ConnectionHealth {...connectionsState} />
        </div>
      </div>
    </div>
  );
}

