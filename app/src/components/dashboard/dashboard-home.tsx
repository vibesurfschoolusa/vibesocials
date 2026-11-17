"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Link2, PenSquare } from "lucide-react";
import type { Platform } from "@prisma/client";

import { useServerSaysSignedOut } from "@/components/shell/signed-out-alert";
import { useSignedInAccount } from "@/components/signed-in-swap";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { ConnectionHealth } from "@/components/dashboard/connection-health";
import { GettingStarted, WorkingForClients } from "@/components/dashboard/getting-started";
import { YouTubeMetricsSummary } from "@/components/dashboard/youtube-metrics-summary";
import { PublishHealthCard } from "@/components/dashboard/publish-health-card";
import { ListingMetricsCard } from "@/components/dashboard/listing-metrics-card";
import { NeedsYou } from "@/components/dashboard/needs-you";
import { hasGoogleListing, shouldMountNeedsYou } from "@/lib/needsYou";
import { firstName } from "@/lib/accountInitials";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { useConnections } from "@/hooks/useConnections";
import { usePostJobs } from "@/hooks/usePostJobs";
import {
  COMPOSE_CTA,
  dashboardHeading,
  deriveDashboardCta,
  deriveGettingStarted,
  type WorkspaceSetup,
} from "@/lib/gettingStarted";

/**
 * The signed-in home page (moved from app/page.tsx in 2026-11 so the page can
 * decide on the server). The app shell only wraps a page once the client-side
 * session has loaded, so the dashboard waits for it too: mounting earlier drew
 * it without the shell, then remounted it inside (a visible jump and a second
 * round of fetches).
 */
type DashboardProps = {
  availablePlatforms: readonly Platform[];
  /** R32: the workspace the page was drawn for, which every read sends; null when it couldn't be read. */
  workspaceId: string | null;
  /** The page's server read of the active workspace; null when it failed. */
  setup: WorkspaceSetup | null;
  /** A sentence the page was opened with (R2-client-journey L2: /go for another workspace); null for none. */
  notice?: string | null;
};

export function DashboardHome({ availablePlatforms, workspaceId, setup, notice }: DashboardProps) {
  const { status } = useSession();
  const signedIn = useSignedInAccount() !== null;
  const router = useRouter();
  // R20 new-customer L1: the server rendered this for someone, and the tab's
  // session now names nobody (signed out elsewhere). Once the server confirms
  // it (a failed next-auth fetch also reads as nobody; FF1 review), refresh
  // once; the server renders the Landing. Never sign out from here.
  const confirmedSignedOut = useServerSaysSignedOut(status !== "loading" && !signedIn);
  const refreshed = useRef(false);
  useEffect(() => {
    if (!confirmedSignedOut || refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [confirmedSignedOut, router]);

  // R15-pages L2: the server HTML for a signed-in "/" is the not-signed-in
  // branch, so the page's heading and its loading line are there too.
  // R30 PP2: the loading line is outside the branches, on the page from the
  // first render; only its text changes.
  return (
    <>
      <p role="status" className="sr-only">{signedIn ? "" : "Loading your dashboard…"}</p>
      {signedIn ? (
        <Dashboard availablePlatforms={availablePlatforms} workspaceId={workspaceId} setup={setup} notice={notice} />
      ) : (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <h1 className="sr-only">Dashboard</h1>
          <Spinner size="lg" className="text-muted-foreground" />
        </div>
      )}
    </>
  );
}

function Dashboard({ availablePlatforms, workspaceId, setup, notice }: DashboardProps) {
  // Task 8 — single fetch/poll owner for the dashboard: both widgets below
  // took this over their own `usePostJobs()` call, so the dashboard makes one
  // `/api/posts` request (and one poll timer) instead of two. Same pattern
  // for connections: this is the one `/api/connections` fetch, shared by the
  // Get started checklist and the ConnectionHealth widget.
  const postJobs = usePostJobs(workspaceId);
  const connectionsState = useConnections(workspaceId);
  const { data: session } = useSession();

  // Both derivations are pure and cheap, so each consumer re-derives from the
  // same two fetches rather than threading state through props.
  const onboarding = deriveGettingStarted(
    connectionsState.connections,
    postJobs.jobs,
    setup,
  );

  // Header state is three-way, not two: "still loading" and "loaded but the
  // fetch failed" both leave the data null, and only the first of them should
  // show a skeleton — otherwise a failed request parks a skeleton on screen
  // permanently. On failure we degrade to the neutral heading and the
  // steady-state CTA rather than asserting anything we can't back up.
  const headerLoading = connectionsState.loading || postJobs.loading;
  const cta = deriveDashboardCta(connectionsState.connections, setup?.role ?? null) ?? COMPOSE_CTA;

  // Latched: once the card is mounted, a manual reload of posts or
  // connections (loading flips back to true) must not unmount it and fire its
  // one-per-visit fetches again. Set during render, React's pattern for state
  // derived from a change.
  const [needsYouMounted, setNeedsYouMounted] = useState(false);
  if (
    !needsYouMounted &&
    shouldMountNeedsYou({
      connectionsLoading: connectionsState.loading,
      postsLoading: postJobs.loading,
      gettingStartedShowing: onboarding.show,
    })
  ) {
    setNeedsYouMounted(true);
  }

  return (
    <div className={APP_PAGE_CLASS}>
      {notice ? (
        <Alert variant="warning" className="mb-6">
          <p>{notice}</p>
        </Alert>
      ) : null}
      {/* The greeting and the CTA read from the same two fetches, so the whole
          header resolves at once. Skeletons until then: a heading that says
          "Welcome back" and then corrects itself to "Welcome to Vibe Socials"
          — or a button whose label swaps under the cursor — is worse than a
          beat of nothing. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {headerLoading ? (
          <div>
            {/* R14-pages L3: the page keeps its h1 while loading, under the
                neutral heading dashboardHeading gives before anything is known. */}
            <h1 className="sr-only">Dashboard</h1>
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {dashboardHeading(onboarding, firstName(session?.user?.name))}
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
          {/* N1: what wants the owner today. Waits for the connections and
              posts fetches (loaded or failed) so a new user never meets it
              while the Get started checklist, its own to-do list, is about to
              appear, and so the connections it reads are known on its one
              mount. Hidden whenever the checklist shows. */}
          {needsYouMounted && !onboarding.show ? (
            <NeedsYou workspaceId={workspaceId} hasGoogleListing={hasGoogleListing(connectionsState.connections)} />
          ) : null}
          {/* First-run checklist — renders nothing once this person's steps
              are done (see lib/gettingStarted.ts). */}
          <GettingStarted
            connections={connectionsState.connections}
            jobs={postJobs.jobs}
            setup={setup}
            availablePlatforms={availablePlatforms}
          />
          {/* Roadmap Phase 8 — renders only once a YouTube post has fetched metrics. */}
          <YouTubeMetricsSummary jobs={postJobs.jobs} availablePlatforms={availablePlatforms} />
          {/* While the checklist is up it owns the "create your first post"
              instruction; a second copy of it directly below competes with the
              step the user is actually on. */}
          <RecentActivity {...postJobs} showCreateCta={!onboarding.show} />
          {/* Owners only, below the main content. */}
          <WorkingForClients connections={connectionsState.connections} jobs={postJobs.jobs} setup={setup} />
        </div>
        <div className="space-y-6">
          <ConnectionHealth {...connectionsState} isMember={setup?.role === "member"} />
          {/* Renders only once this workspace has finished at least one
              publish, so a new user never meets an empty "0%" card. */}
          <PublishHealthCard workspaceId={workspaceId} />
          {/* Renders only once the workspace's chosen Google listing has a
              stored day of numbers (google-listing-metrics-sync). */}
          <ListingMetricsCard workspaceId={workspaceId} viewerRole={setup?.role ?? null} />
        </div>
      </div>
    </div>
  );
}

