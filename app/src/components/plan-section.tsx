import { Card } from "@/components/ui/card";
import { formatStorageGb } from "@/lib/usageLimits";
import type { WorkspaceUsage } from "@/server/usage/workspaceUsage";

/**
 * Settings → Plan (21a): the plan state in words and the limits that apply.
 * Rendered on the server, for owners and only with billing on (the page
 * decides through planSectionLabel). No buttons yet: choosing a plan comes
 * with the payment provider (21b). The limits are the ones the usage counts
 * were read with, so they are what is enforced; null when they could not be read.
 */
export function PlanSection({ label, usage }: { label: string; usage: WorkspaceUsage | null }) {
  return (
    <Card className="flex flex-col gap-3 p-6">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {usage ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Posts per day</dt>
            <dd>{usage.postsToday.limit}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">X posts per month</dt>
            <dd>{usage.xPostsThisMonth.limit}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">YouTube uploads per day</dt>
            <dd>{usage.youtubeUploadsToday.limit}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Media storage</dt>
            <dd>{formatStorageGb(usage.storage.limit)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">The limits are not available right now. Reload the page to try again.</p>
      )}
    </Card>
  );
}
