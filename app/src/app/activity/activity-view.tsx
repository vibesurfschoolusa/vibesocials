"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Inbox, PlusCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { LoadError, LoadMoreButton } from "@/components/load-error";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PostJobCard } from "@/components/activity/post-job-card";
import { usePostJobs } from "@/hooks/usePostJobs";
import { cn } from "@/lib/cn";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { POLLING_STOPPED_HINT } from "@/lib/postJobPolling";

import {
  activityEmptyState,
  activityFilterFromSearch,
  activityFilterHref,
  type ActivityFilter,
} from "./activity-filter";

const FILTER_TABS: readonly (readonly [ActivityFilter, string])[] = [
  ["all", "All posts"],
  ["problems", "Had a problem"],
];

/**
 * Client-rendered activity list. The parent server component gates access and
 * passes the workspace the page was drawn for (R32), which every read sends.
 */
export function ActivityView({ workspaceId }: { workspaceId: string | null }) {
  // useSearchParams needs a Suspense boundary above it (same as register-form).
  return (
    <Suspense fallback={null}>
      <ActivityViewInner pageWorkspaceId={workspaceId} />
    </Suspense>
  );
}

function ActivityViewInner({ pageWorkspaceId }: { pageWorkspaceId: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = activityFilterFromSearch(searchParams);
  const empty = activityEmptyState(filter);
  const {
    jobs,
    loading,
    error,
    reload,
    workspaceMemberCount,
    workspaceRole,
    workspaceId,
    workspaceChanged,
    loadMore,
    loadingMore,
    loadMoreError,
    hasMore,
    watchRetry,
    pollingStopped,
  } = usePostJobs(pageWorkspaceId, filter === "problems" ? { show: "problems" } : undefined);
  // Team Workspaces (Task 7, design §7) — attribution only in a shared
  // (>1-member) workspace, so a solo workspace's activity feed is unchanged.
  const showAttribution = (workspaceMemberCount ?? 0) > 1;

  return (
    <div className={APP_PAGE_CLASS}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Activity
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything you&apos;ve created — drafts, scheduled posts, and how each
            platform responded.
          </p>
        </div>
        <Link
          href="/posts/new"
          className={buttonVariants({ variant: "primary", className: "gap-2" })}
        >
          <PlusCircle aria-hidden className="h-4 w-4" />
          Create post
        </Link>
      </div>

      {/* Same segmented-toggle pattern as the Queue's List/Calendar switch. The
          URL is replaced, not pushed, so Back leaves the page. */}
      <div
        role="group"
        aria-label="Which posts"
        className="mt-6 inline-flex gap-0.5 rounded-[var(--radius)] border border-input p-0.5"
      >
        {FILTER_TABS.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={filter === mode}
            onClick={() => router.replace(activityFilterHref(mode), { scroll: false })}
            className={cn(
              "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              filter === mode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {/* R30 PP2: status lines stay on the page from the first render; only their text changes. */}
        <p role="status" className="sr-only">{loading ? "Loading activity…" : ""}</p>
        {loading ? (
          <>
            <div className="space-y-3" aria-hidden>
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-28 w-full" />
              ))}
            </div>
          </>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your activity">
            <LoadError message={error} onRetry={reload} />
          </Alert>
        ) : !jobs || jobs.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={empty.title}
            description={empty.description ?? undefined}
            action={
              empty.showCreate ? (
                <Link
                  href="/posts/new"
                  className={buttonVariants({ variant: "primary" })}
                >
                  Create your first post
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* 2026-11-01 scale audit (W5): polling gave up after 30 minutes. */}
            {pollingStopped ? (
              <Alert variant="info" className="mb-3">
                {POLLING_STOPPED_HINT}
              </Alert>
            ) : null}
            {/* R32: another tab switched workspace; the list stays as it was. */}
            {workspaceChanged ? (
              <Alert variant="warning" className="mb-3">
                {workspaceChanged}
              </Alert>
            ) : null}
            <div className="space-y-3">
              {jobs.map((job) => (
                <PostJobCard
                  key={job.id}
                  job={job}
                  showAttribution={showAttribution}
                  viewerRole={workspaceRole ?? "owner"}
                  workspaceId={workspaceId}
                  onRetryAccepted={watchRetry}
                />
              ))}
            </div>
            {hasMore ? (
              <div className="mt-4 flex flex-col items-center gap-2">
                <LoadMoreButton error={loadMoreError} loading={loadingMore} onLoadMore={loadMore} />
              </div>
            ) : null}
          </>
        )}
        {/* R26 LL3: why the last Load more failed; the next press retries. */}
        <p role="status" className="mt-2 text-center text-sm text-destructive empty:sr-only">{loadMoreError}</p>
      </div>
    </div>
  );
}
