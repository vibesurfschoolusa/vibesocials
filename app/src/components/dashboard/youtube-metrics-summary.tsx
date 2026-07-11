"use client";

import { Eye, MessageCircle, ThumbsUp, type LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { summarizeYouTubeMetrics } from "@/lib/metricsSummary";
import { usePostJobs } from "@/hooks/usePostJobs";

interface SummaryStatProps {
  icon: LucideIcon;
  label: string;
  value: number;
}

function SummaryStat({ icon: Icon, label, value }: SummaryStatProps) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

/**
 * Roadmap Phase 8 — dashboard YouTube performance summary. Reuses the same
 * `GET /api/posts` payload the recent-activity feed loads (via `usePostJobs`)
 * and aggregates it with the pure `summarizeYouTubeMetrics`, so it needs no new
 * endpoint. Renders nothing until there is at least one YouTube video with a
 * fetched metric — so users who don't post to YouTube (or whose first sync
 * hasn't run yet) never see an empty "0 views" card.
 */
export function YouTubeMetricsSummary() {
  const { jobs } = usePostJobs();

  if (!jobs) {
    return null;
  }

  const summary = summarizeYouTubeMetrics(jobs);
  if (summary.trackedVideos === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">YouTube performance</CardTitle>
        <CardDescription>
          {/* "recent" is honest: the aggregate covers the recent jobs the
              activity feed loads, not the user's entire history (review Minor #4). */}
          Across {summary.trackedVideos} recent{" "}
          {summary.trackedVideos === 1 ? "video" : "videos"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-4">
          <SummaryStat icon={Eye} label="Views" value={summary.totalViews} />
          <SummaryStat icon={ThumbsUp} label="Likes" value={summary.totalLikes} />
          <SummaryStat
            icon={MessageCircle}
            label="Comments"
            value={summary.totalComments}
          />
        </dl>
      </CardContent>
    </Card>
  );
}
