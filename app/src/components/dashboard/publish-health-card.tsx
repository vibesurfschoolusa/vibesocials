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
 * than the fact deserves.
 */
export function PublishHealthCard() {
  const [data, setData] = useState<PublishHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/insights/publish-health");
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
  }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Publish health</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="status" className="sr-only">
            Loading publish health…
          </p>
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.overall.attempted === 0 || data.overall.successRate === null) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Publish health</CardTitle>
        <CardDescription>
          {data.overall.succeeded} of {data.overall.attempted}{" "}
          {data.overall.attempted === 1 ? "publish" : "publishes"} landed in the last{" "}
          {data.windowDays} days
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums tracking-tight",
                rateTone(data.overall.successRate),
              )}
            >
              {data.overall.successRate}%
            </span>
            <span className="text-xs text-muted-foreground">overall success</span>
          </div>

          <dl className="space-y-2">
            {data.platforms.map((platform) => (
              <div key={platform.platform} className="flex items-center gap-3">
                <dt className="w-40 shrink-0 truncate text-sm text-foreground">
                  {platformLabel(platform.platform)}
                </dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2">
                  <div
                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
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
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {platform.succeeded}/{platform.attempted} · {platform.successRate}%
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}
