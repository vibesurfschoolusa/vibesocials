"use client";

import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PostJobCard } from "@/components/activity/post-job-card";
import { usePostJobs } from "@/hooks/usePostJobs";

const PREVIEW_COUNT = 5;

/** Dashboard widget: the most recent post jobs with a link to the full view. */
export function RecentActivity() {
  const { jobs, loading, error, reload } = usePostJobs();
  const preview = jobs ? jobs.slice(0, PREVIEW_COUNT) : [];

  return (
    <section aria-labelledby="recent-activity-heading">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id="recent-activity-heading"
          className="text-lg font-semibold text-foreground"
        >
          Recent activity
        </h2>
        {jobs && jobs.length > 0 ? (
          <Link
            href="/activity"
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "gap-1",
            })}
          >
            View all
            <ArrowRight aria-hidden className="h-4 w-4" />
          </Link>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-3" aria-hidden>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="danger" title="Couldn't load activity">
          <div className="flex flex-col items-start gap-3">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : preview.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No posts yet"
          description="Create your first post and it'll show up here with a per-platform status breakdown."
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
          {preview.map((job) => (
            <PostJobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  );
}
