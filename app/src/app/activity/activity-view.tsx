"use client";

import Link from "next/link";
import { Inbox, PlusCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PostJobCard } from "@/components/activity/post-job-card";
import { usePostJobs } from "@/hooks/usePostJobs";

/** Client-rendered activity list. The parent server component gates access. */
export function ActivityView() {
  const { jobs, loading, error, reload } = usePostJobs();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
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

      <div className="mt-8">
        {loading ? (
          <div className="space-y-3" aria-hidden>
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your activity">
            <div className="flex flex-col items-start gap-3">
              <p>{error}</p>
              <Button size="sm" variant="outline" onClick={reload}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : !jobs || jobs.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title="No posts yet"
            description="When you publish a post, it'll appear here with a per-platform breakdown of what succeeded and what failed."
            action={
              <Link
                href="/posts/new"
                className={buttonVariants({ variant: "primary" })}
              >
                Create your first post
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <PostJobCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
