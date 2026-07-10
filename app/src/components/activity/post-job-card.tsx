"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { PostJobStatus } from "@prisma/client";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import type { PostJobDTO } from "@/lib/postsDto";
import { PlatformResultBadge } from "./platform-result";

const JOB_STATUS_META: Record<
  PostJobStatus,
  { variant: BadgeVariant; label: string }
> = {
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "danger", label: "Failed" },
  in_progress: { variant: "warning", label: "In progress" },
  pending: { variant: "neutral", label: "Pending" },
};

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
 */
export function PostJobCard({ job }: { job: PostJobDTO }) {
  const [expanded, setExpanded] = useState(false);
  const status = JOB_STATUS_META[job.status];
  const results = orderResults(job.results);
  const failures = results.filter(
    (result) => result.status === "failed" && result.errorMessage,
  );

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {job.caption?.trim() || "Untitled post"}
          </p>
          {job.createdAt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              <time dateTime={job.createdAt}>{formatTimestamp(job.createdAt)}</time>
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
              status={result.status}
            />
          ))}
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
