import { redirect } from "next/navigation";
import type { Platform } from "@prisma/client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { platformLabel } from "@/lib/platforms";
import { getWorkspaceContext } from "@/lib/workspace";
import {
  getWorkspacesOverview,
  type WorkspaceOverviewEntry,
} from "@/server/overview/workspaceOverview";
import { OpenWorkspaceButton } from "./open-workspace-button";

function platformList(platforms: Platform[]): string {
  return platforms.map(platformLabel).join(", ");
}

function Stat({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-lg font-semibold", alert ? "text-danger-ontint" : "text-foreground")}>
        {value}
      </dd>
    </div>
  );
}

function WorkspaceRow({ entry, isActive }: { entry: WorkspaceOverviewEntry; isActive: boolean }) {
  return (
    <Card className={cn("flex flex-col gap-4 p-4 sm:p-5", entry.needsAttention && "border-warning/50")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">{entry.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral">{entry.role === "owner" ? "Owner" : "Member"}</Badge>
            {isActive ? <Badge variant="success">Active</Badge> : null}
            {entry.needsAttention ? <Badge variant="warning">Needs attention</Badge> : null}
          </div>
        </div>
        <OpenWorkspaceButton workspaceId={entry.workspaceId} name={entry.name} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Posts this month" value={entry.postsThisMonth} />
        <Stat label="Scheduled" value={entry.scheduled} />
        <Stat
          label="Waiting for approval"
          value={entry.waitingForApproval}
          alert={entry.waitingForApproval > 0}
        />
        <Stat
          label="Failed in the last 7 days"
          value={entry.failedLast7Days}
          alert={entry.failedLast7Days > 0}
        />
        <Stat label="Connected" value={entry.connected} />
      </dl>

      {entry.failedPlatforms.length > 0 || entry.needsReconnect.length > 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          {entry.failedPlatforms.length > 0 ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Failed on:</span>{" "}
              {platformList(entry.failedPlatforms)}
            </p>
          ) : null}
          {entry.needsReconnect.length > 0 ? (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Needs reconnecting:</span>{" "}
              {platformList(entry.needsReconnect)}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// Server-side auth gate (as queue/page.tsx). getWorkspaceContext is also
// what tells us which workspace is active now; it is null when signed out.
export const metadata = { title: "Workspaces | Vibe Socials" };

export default async function WorkspacesPage() {
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/workspaces")}`);
  }

  // Scoped to the signed-in user's own memberships; nothing from the request.
  const entries = await getWorkspacesOverview(context.user.id, new Date());
  const anyAttention = entries.some((entry) => entry.needsAttention);

  return (
    <div className={APP_PAGE_CLASS}>
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Workspaces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every workspace you belong to. Open one to work in it.
        </p>
      </header>

      {anyAttention ? null : (
        <Alert variant="success" className="mb-6">
          Nothing needs your attention in any workspace.
        </Alert>
      )}

      <div className="flex flex-col gap-4">
        {entries.map((entry) => (
          <WorkspaceRow
            key={entry.workspaceId}
            entry={entry}
            isActive={entry.workspaceId === context.workspace.id}
          />
        ))}
      </div>
    </div>
  );
}
