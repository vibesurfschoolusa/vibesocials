import type { Platform, WorkspaceRole } from "@prisma/client";

import { prisma } from "@/lib/db";
import { utcMonthRange } from "@/lib/usageLimits";

/**
 * The all-workspaces page (2026-11-10): one entry per workspace the user
 * belongs to. Every count is scoped to the workspace ids read from the user's
 * own WorkspaceMember rows, never to a request parameter, and is loaded with a
 * fixed number of grouped queries for all of them together (a user can belong
 * to 25 or more).
 */

export interface WorkspaceOverviewEntry {
  workspaceId: string;
  name: string;
  role: WorkspaceRole;
  /** Posts with at least one successful result finished in the current UTC month. */
  postsThisMonth: number;
  scheduled: number;
  /** Drafts submitted for approval and not yet decided. */
  waitingForApproval: number;
  /** Platform results that failed and finished in the last 7 days. */
  failedLast7Days: number;
  failedPlatforms: Platform[];
  needsReconnect: Platform[];
  /** Connected platforms, including any that need reconnecting. */
  connected: number;
  /** A failure, a reconnect or an approval waiting. */
  needsAttention: boolean;
}

const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function countsByWorkspace(groups: { workspaceId: string; _count: { _all: number } }[]): Map<string, number> {
  return new Map(groups.map((group) => [group.workspaceId, group._count._all]));
}

export async function getWorkspacesOverview(userId: string, now: Date): Promise<WorkspaceOverviewEntry[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true } } },
  });
  if (memberships.length === 0) return [];

  const scope = { in: memberships.map((membership) => membership.workspace.id) };
  const month = utcMonthRange(now);
  const failedSince = new Date(now.getTime() - FAILURE_WINDOW_MS);

  const [monthGroups, scheduledGroups, approvalGroups, failedGroups, connections] = await Promise.all([
    // From PostJobResult directly, on its [workspaceId, updatedAt] index: a
    // PostJob filter on `results: { some }` becomes a subquery over the whole
    // result table. One row per (workspace, post), counted per workspace below.
    prisma.postJobResult.groupBy({
      by: ["workspaceId", "postJobId"],
      where: {
        workspaceId: scope,
        status: "success",
        updatedAt: { gte: month.start, lt: month.end },
      },
    }),
    prisma.postJob.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: scope, status: "scheduled" },
      _count: { _all: true },
    }),
    // isHeldForApproval (lib/approval.ts): a draft whose deriveApprovalState is
    // "pending" — submitted, not approved; a draft is never the cancelled
    // status that reads as "rejected".
    prisma.postJob.groupBy({
      by: ["workspaceId"],
      where: {
        workspaceId: scope,
        status: "draft",
        submittedForApprovalAt: { not: null },
        approvedAt: null,
      },
      _count: { _all: true },
    }),
    // updatedAt is when a result finished (see publish-health).
    prisma.postJobResult.groupBy({
      by: ["workspaceId", "platform"],
      where: { workspaceId: scope, status: "failed", updatedAt: { gte: failedSince } },
      _count: { _all: true },
    }),
    // At most one row per platform per workspace (@@unique), so this stays small.
    prisma.socialConnection.findMany({
      where: { workspaceId: scope },
      select: { workspaceId: true, platform: true, needsReconnect: true },
    }),
  ]);

  const postsThisMonth = new Map<string, number>();
  for (const { workspaceId } of monthGroups) {
    if (workspaceId) postsThisMonth.set(workspaceId, (postsThisMonth.get(workspaceId) ?? 0) + 1);
  }
  const scheduled = countsByWorkspace(scheduledGroups);
  const waitingForApproval = countsByWorkspace(approvalGroups);

  const entries = memberships.map(({ role, workspace }): WorkspaceOverviewEntry => {
    const failed = failedGroups.filter((group) => group.workspaceId === workspace.id);
    const own = connections.filter((connection) => connection.workspaceId === workspace.id);
    const failedLast7Days = failed.reduce((sum, group) => sum + group._count._all, 0);
    const needsReconnect = own
      .filter((connection) => connection.needsReconnect)
      .map((connection) => connection.platform)
      .sort();
    const waiting = waitingForApproval.get(workspace.id) ?? 0;
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      role,
      postsThisMonth: postsThisMonth.get(workspace.id) ?? 0,
      scheduled: scheduled.get(workspace.id) ?? 0,
      waitingForApproval: waiting,
      failedLast7Days,
      failedPlatforms: failed.map((group) => group.platform).sort(),
      needsReconnect,
      connected: own.length,
      needsAttention: failedLast7Days > 0 || needsReconnect.length > 0 || waiting > 0,
    };
  });

  return entries.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
