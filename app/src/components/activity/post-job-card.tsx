"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { Platform, PostJobResultStatus, PostJobStatus } from "@prisma/client";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { MediaThumb } from "@/components/media-thumb";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { platformPostUrl } from "@/lib/platformPostUrl";
import type { PostJobDTO } from "@/lib/postsDto";
import { PlatformResultBadge } from "./platform-result";
import { PostMetricStats } from "./post-metric-stats";

// Exhaustive over PostJobStatus — adding an enum member (Roadmap Phase 5 added
// draft/scheduled/cancelled) fails `tsc` here (TS2741) until it's listed, which
// is the intended tripwire the spec calls out.
const JOB_STATUS_META: Record<
  PostJobStatus,
  { variant: BadgeVariant; label: string }
> = {
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "danger", label: "Failed" },
  in_progress: { variant: "warning", label: "In progress" },
  pending: { variant: "neutral", label: "Pending" },
  scheduled: { variant: "secondary", label: "Scheduled" },
  draft: { variant: "neutral", label: "Draft" },
  cancelled: { variant: "outline", label: "Cancelled" },
};

/** Shape of the retry endpoint's JSON error body (Roadmap Phase 3). */
interface RetryErrorBody {
  error?: string;
  code?: string;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function orderResults(results: PostJobDTO["results"]): PostJobDTO["results"] {
  return [...results].sort(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform),
  );
}

/**
 * A single post job: caption preview, timestamp, overall status, and per-platform
 * result pills. Sanitized failure messages are collapsed behind a toggle.
 *
 * Roadmap Phase 3: each failed platform gets a Retry button that re-publishes
 * just that platform (`POST /api/posts/[id]/retry`). The result is optimistically
 * shown as pending; a `RECONNECT_REQUIRED` response swaps the button for a
 * "Reconnect … in Settings" link.
 *
 * Team Workspaces (Task 7) — `showAttribution` (default off, so existing
 * single-member callers are unchanged) shows `by {createdBy.name}` next to
 * the timestamp when the job carries a creator. Callers gate this on
 * `workspaceMemberCount > 1` (design doc §7) before passing it down.
 */
export function PostJobCard({
  job,
  showAttribution = false,
}: {
  job: PostJobDTO;
  showAttribution?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Platforms whose retry is in flight (optimistic pending) and platforms the
  // server told us to reconnect. Both are keyed by Platform.
  const [pending, setPending] = useState<Set<Platform>>(new Set());
  const [reconnect, setReconnect] = useState<Set<Platform>>(new Set());
  const toast = useToast();

  // Task 8 — polling (usePostJobs) delivers a fresh `job` object identity
  // every 10s. Reset ONLY the optimistic `pending` set when that happens: the
  // server has already flipped a claimed retry to `pending` by the time its
  // response resolves (see retry/route.ts's atomic updateMany), so
  // `result.status` takes over as the truthful source and the UI still reads
  // "pending" until it resolves to success/failed. `reconnect` is
  // server-derived (from a RECONNECT_REQUIRED response), not optimism, so
  // it's left untouched here.
  //
  // Adjusted during render — React's documented pattern for resetting state
  // when a prop changes ("Storing information from previous renders" in the
  // React docs) — rather than in a useEffect: an unconditional setState at
  // the top of an effect body is the derived-state anti-pattern this repo's
  // lint config blocks (react-hooks/set-state-in-effect; see the analogous
  // note in media-library.tsx's fetchItems).
  const [prevJob, setPrevJob] = useState(job);
  if (job !== prevJob) {
    setPrevJob(job);
    setPending(new Set());
  }

  const status = JOB_STATUS_META[job.status];
  const results = orderResults(job.results);

  // Roadmap Phase 8: a job fans out to one result per platform, so there is at
  // most one YouTube result. Show its engagement stats once it succeeded (only
  // then does it carry the externalPostId the metric is keyed on); the row shows
  // "—" until the hourly sync cron fetches the counts.
  const youtubeResult = results.find(
    (result) =>
      result.platform === "youtube" &&
      result.status === "success" &&
      Boolean(result.externalPostId),
  );

  // A platform mid-retry displays as pending even though its stored result is
  // still `failed` until the background job finishes.
  const displayStatus = (
    result: PostJobDTO["results"][number],
  ): PostJobResultStatus =>
    pending.has(result.platform) ? "pending" : result.status;

  const failedPlatforms = results
    .filter((result) => result.status === "failed")
    .map((result) => result.platform);

  // Hide a failure's stored error message while it's being retried (we've
  // optimistically cleared it).
  const failures = results.filter(
    (result) =>
      result.status === "failed" &&
      result.errorMessage &&
      !pending.has(result.platform),
  );

  const retry = useCallback(
    async (platform: Platform) => {
      setReconnect((prev) => {
        if (!prev.has(platform)) return prev;
        const next = new Set(prev);
        next.delete(platform);
        return next;
      });
      setPending((prev) => new Set(prev).add(platform));

      try {
        const response = await fetch(`/api/posts/${job.id}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform }),
        });

        if (response.ok) {
          toast.success(`Retrying ${platformLabel(platform)}…`);
          return; // keep the optimistic pending state
        }

        let body: RetryErrorBody = {};
        try {
          body = (await response.json()) as RetryErrorBody;
        } catch {
          // Non-JSON error — fall through to the generic message below.
        }

        // Roll back the optimistic pending state: the retry never started.
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(platform);
          return next;
        });

        if (body.code === "RECONNECT_REQUIRED") {
          setReconnect((prev) => new Set(prev).add(platform));
          toast.error(
            body.error ??
              `Reconnect ${platformLabel(platform)} in Settings before retrying.`,
          );
          return;
        }

        toast.error(
          body.error ??
            `Couldn't retry ${platformLabel(platform)}. Please try again.`,
        );
      } catch {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(platform);
          return next;
        });
        toast.error(
          `Couldn't retry ${platformLabel(platform)}. Please try again.`,
        );
      }
    },
    [job.id, toast],
  );

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <MediaThumb media={job.media} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {job.caption?.trim() || "Untitled post"}
          </p>
          {job.status === "scheduled" && job.scheduledFor ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Scheduled for{" "}
              <time dateTime={job.scheduledFor}>
                {formatTimestamp(job.scheduledFor)}
              </time>
              {showAttribution && job.createdBy ? <> · by {job.createdBy.name}</> : null}
            </p>
          ) : job.createdAt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              <time dateTime={job.createdAt}>{formatTimestamp(job.createdAt)}</time>
              {showAttribution && job.createdBy ? <> · by {job.createdBy.name}</> : null}
            </p>
          ) : null}
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      {results.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {results.map((result) => (
            <PlatformResultBadge
              key={result.platform}
              platform={result.platform}
              status={displayStatus(result)}
            />
          ))}
        </div>
      ) : null}

      {job.status === "failed" && results.length === 0 ? (
        <p className="mt-3 rounded-[var(--radius)] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-foreground">
          This post failed because no platforms were connected when it ran. Connect a
          platform in <Link href="/settings" className="font-medium text-primary underline underline-offset-2">Settings</Link> and create it again.
        </p>
      ) : null}

      {results.some((r) => r.status === "success" && platformPostUrl(r.platform, r.externalPostId)) ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {results.map((result) => {
            const url = result.status === "success" ? platformPostUrl(result.platform, result.externalPostId) : null;
            if (!url) return null;
            return (
              <a
                key={result.platform}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View on {platformLabel(result.platform)}
                <ExternalLink aria-hidden className="h-3 w-3" />
              </a>
            );
          })}
        </div>
      ) : null}

      {youtubeResult ? <PostMetricStats metric={youtubeResult.metric} /> : null}

      {failedPlatforms.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {failedPlatforms.map((platform) =>
            reconnect.has(platform) ? (
              <span
                key={platform}
                className="inline-flex items-center gap-1 rounded-[var(--radius)] border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs text-foreground"
              >
                Reconnect {platformLabel(platform)} in{" "}
                <Link
                  href="/settings"
                  className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                >
                  Settings
                </Link>
              </span>
            ) : (
              <Button
                key={platform}
                size="sm"
                variant="outline"
                loading={pending.has(platform)}
                onClick={() => retry(platform)}
              >
                {pending.has(platform) ? "Retrying" : "Retry"}{" "}
                {platformLabel(platform)}
              </Button>
            ),
          )}
        </div>
      ) : null}

      {failures.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "Hide" : "Show"} {failures.length}{" "}
            {failures.length === 1 ? "error" : "errors"}
          </button>
          {expanded ? (
            <ul className="mt-2 space-y-1.5">
              {failures.map((result) => (
                <li
                  key={result.platform}
                  className="rounded-[var(--radius)] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-foreground"
                >
                  <span className="font-semibold">
                    {platformLabel(result.platform)}:
                  </span>{" "}
                  {result.errorMessage}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
