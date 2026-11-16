"use client";

import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { withWorkspaceId } from "@/lib/workspaceChanged";
import { platformLabel } from "@/lib/platforms";
import type { PublishHealthSummary } from "@/lib/publishHealth";

interface PublishHealthResponse extends PublishHealthSummary {
  windowDays: number;
}

/** Green when everything landed, amber when some failed, red when most did. */
function rateTone(rate: number): string {
  if (rate >= 95) return "text-success-ontint";
  if (rate >= 75) return "text-warning-ontint";
  return "text-destructive";
}

/**
 * Dashboard publish-health card: per-platform success rates over the last 30
 * days, built from the PostJobResult rows the app already writes — so it covers
 * every platform (PostMetric is YouTube-only) and calls no provider API.
 *
 * Renders nothing when the workspace has never finished a publish, so a new
 * user never meets an empty "0%" card. A failed fetch also renders nothing:
 * this is supplementary information, and a red error box for it would be louder
 * than the fact deserves. R32: it reads for the workspace the page was drawn
 * for, so a refusal (another tab switched) also renders nothing.
 */
export function PublishHealthCard({ workspaceId }: { workspaceId: string | null }) {
  const [data, setData] = useState<PublishHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(withWorkspaceId("/api/insights/publish-health", workspaceId));
        if (!response.ok) return;
        const payload: PublishHealthResponse = await response.json();
        if (!cancelled) setData(payload);
      } catch {
        // Supplementary card — stay silent and render nothing.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Shown only once this workspace has finished at least one publish (the rate is then a number).
  const shown =
    !loading && data && data.overall.attempted > 0 && data.overall.successRate !== null
      ? { ...data, overall: { ...data.overall, successRate: data.overall.successRate } }
      : null;

  // R30 PP2: the loading line is outside the views, on the page from the
  // first render; only its text changes.
  return (
    <>
      <p role="status" className="sr-only">
        {loading ? "Loading publish health…" : ""}
      </p>
      {loading ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publish health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
            </div>
          </CardContent>
        </Card>
      ) : shown ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Publish health</CardTitle>
            <CardDescription>
              {shown.overall.succeeded} of {shown.overall.attempted}{" "}
              {shown.overall.attempted === 1 ? "publish" : "publishes"} landed in the last{" "}
              {shown.windowDays} days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "text-2xl font-semibold tabular-nums tracking-tight",
                    rateTone(shown.overall.successRate),
                  )}
                >
                  {shown.overall.successRate}%
                </span>
                <span className="text-xs text-muted-foreground">overall success</span>
              </div>

              {/* Name and counts share a row; the bar spans the full width beneath.
                  Keeping all three on one line collapsed the bar to nothing in the
                  dashboard's narrow sidebar. */}
              <dl className="space-y-3">
                {shown.platforms.map((platform) => (
                  <div key={platform.platform} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="min-w-0 truncate text-sm text-foreground">
                        {platformLabel(platform.platform)}
                      </dt>
                      <dd className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {platform.succeeded}/{platform.attempted} · {platform.successRate}%
                      </dd>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${platformLabel(platform.platform)}: ${platform.succeeded} of ${platform.attempted} succeeded`}
                    >
                      <div
                        className={cn(
                          "h-full rounded-full",
                          platform.successRate >= 95
                            ? "bg-success"
                            : platform.successRate >= 75
                              ? "bg-warning"
                              : "bg-destructive",
                        )}
                        style={{ width: `${platform.successRate}%` }}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
