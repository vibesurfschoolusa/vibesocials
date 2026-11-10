import { Card } from "@/components/ui/card";
import { formatStorageGb, usageResetText, type UsageLimitKind } from "@/lib/usageLimits";
import type { UsageMeter, WorkspaceUsage } from "@/server/usage/workspaceUsage";

interface UsageRow {
  kind: UsageLimitKind;
  label: string;
  meter: UsageMeter;
  format: (value: number) => string;
}

const plain = (value: number) => String(value);

/**
 * Settings → Usage (usage limits, 2026-11-10). Rendered on the server from the
 * same counts the limits are enforced with; every member sees it, read-only.
 */
export function UsageSection({ usage }: { usage: WorkspaceUsage }) {
  const rows: UsageRow[] = [
    { kind: "postsPerDay", label: "Posts today (UTC)", meter: usage.postsToday, format: plain },
    { kind: "xPostsPerMonth", label: "X posts this month", meter: usage.xPostsThisMonth, format: plain },
    {
      kind: "youtubeUploadsPerDay",
      label: "YouTube uploads today (Pacific time)",
      meter: usage.youtubeUploadsToday,
      format: plain,
    },
    { kind: "storage", label: "Media storage", meter: usage.storage, format: formatStorageGb },
  ];

  return (
    <Card className="p-6">
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => {
          const reached = row.meter.used >= row.meter.limit;
          return (
            <li
              key={row.kind}
              className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{row.label}</p>
                <p className="text-xs text-muted-foreground">
                  {usageResetText(row.kind, row.meter.resetsAt)}
                </p>
              </div>
              <p
                className={
                  reached ? "text-sm font-semibold text-destructive" : "text-sm text-foreground"
                }
              >
                {row.format(row.meter.used)} of {row.format(row.meter.limit)}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
