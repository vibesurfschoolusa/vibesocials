import { Card } from "@/components/ui/card";
import {
  formatStorageGb,
  personalUsageText,
  stillTodayText,
  USAGE_UNAVAILABLE_MESSAGE,
  usageResetText,
  type UsageLimitKind,
} from "@/lib/usageLimits";
import type { UsageMeter, WorkspaceUsage } from "@/server/usage/workspaceUsage";

interface UsageRow {
  key: string;
  kind: UsageLimitKind;
  label: string;
  /** Said before when it starts again (the per-person line: why the number is what it is). */
  note?: string;
  meter: UsageMeter;
  format: (value: number) => string;
  /** Shown instead of "x of y" (a member's line: what is left). */
  value?: string;
}

const plain = (value: number) => String(value);

/**
 * Settings → Usage (usage limits, 2026-11-10). Rendered on the server from the
 * same counts the limits are enforced with; every member sees it, read-only.
 * `usage` is null when it could not be read: one line, and Settings still renders.
 *
 * R8-pages M1: where the per-person limit applies, an owner sees each owner's
 * count across all their workspaces (retries included) beside the workspace's
 * own line, since it is the number that binds first; a member sees only how
 * many posts the workspace can still send today and why (review of T1, item 4).
 */
export function UsageSection({ usage }: { usage: WorkspaceUsage | null }) {
  if (!usage) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">{USAGE_UNAVAILABLE_MESSAGE}</p>
      </Card>
    );
  }

  const people = usage.people ?? [];
  const personal: UsageRow[] = people.map((person) => ({
    key: `person-${person.userId}`,
    kind: "postsPerDay",
    ...personalUsageText(person, people.length > 1),
    meter: { used: person.used, limit: person.limit, resetsAt: usage.postsToday.resetsAt },
    format: plain,
  }));
  // Review of T1, item 4: a member sees only what this workspace can still send today, and why.
  const still: UsageRow[] = usage.stillToday
    ? [
        {
          key: "stillToday",
          kind: "postsPerDay",
          ...stillTodayText(usage.stillToday),
          meter: { used: 0, limit: 1, resetsAt: usage.postsToday.resetsAt },
          format: plain,
          value: `${usage.stillToday.remaining} left`,
        },
      ]
    : [];
  const rows: UsageRow[] = [
    {
      key: "postsPerDay",
      kind: "postsPerDay",
      label: people.length > 0 || still.length > 0 ? "Posts today (UTC), this workspace" : "Posts today (UTC)",
      meter: usage.postsToday,
      format: plain,
    },
    ...personal,
    ...still,
    { key: "xPostsPerMonth", kind: "xPostsPerMonth", label: "X posts this month", meter: usage.xPostsThisMonth, format: plain },
    {
      key: "youtubeUploadsPerDay",
      kind: "youtubeUploadsPerDay",
      label: "YouTube uploads today (Pacific time)",
      meter: usage.youtubeUploadsToday,
      format: plain,
    },
    { key: "storage", kind: "storage", label: "Media storage", meter: usage.storage, format: formatStorageGb },
  ];

  return (
    <Card className="p-6">
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => {
          const reached = row.value ? usage.stillToday?.remaining === 0 : row.meter.used >= row.meter.limit;
          return (
            <li
              key={row.key}
              className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium text-foreground">{row.label}</p>
                <p className="text-xs text-muted-foreground">
                  {row.note ? `${row.note} ` : ""}
                  {usageResetText(row.kind, row.meter.resetsAt)}
                </p>
              </div>
              <p
                className={
                  reached ? "text-sm font-semibold text-destructive" : "text-sm text-foreground"
                }
              >
                {row.value ?? `${row.format(row.meter.used)} of ${row.format(row.meter.limit)}`}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
