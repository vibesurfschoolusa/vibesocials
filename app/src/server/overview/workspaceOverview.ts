import type { Platform, Prisma, WorkspaceRole } from "@prisma/client";

import { APPROVAL_DECIDABLE_STATUSES } from "@/lib/approval";
import { CONNECTION_EXPIRY_SELECT, connectionExpiryState } from "@/lib/connectionExpiry";
import { countPostsOnce, withoutPairedStories, type PairableJob } from "@/lib/countOnce";
import { prisma } from "@/lib/db";
import { utcMonthRange } from "@/lib/usageLimits";

/**
 * The all-workspaces page (2026-11-10): one entry per workspace the user
 * belongs to. Every count is scoped to the workspace ids read from the user's
 * own WorkspaceMember rows, never to a request parameter, and is loaded with a
 * fixed number of grouped queries for all of them together (a user can belong
 * to 25 or more).
 *
 * R5-client-journey L2: a Feed and Story post counts once in every count, by
 * the rule in lib/countOnce.ts. L1: what needs attention is what the
 * dashboard's Needs you card lists, client change requests and a Google
 * listing without a location included.
 */

export interface WorkspaceOverviewEntry {
  workspaceId: string;
  name: string;
  role: WorkspaceRole;
  /** Posts with at least one successful result finished in the current UTC month. */
  postsThisMonth: number;
  scheduled: number;
  /** Draft or scheduled posts submitted for approval and not yet decided (as Needs you). */
  waitingForApproval: number;
  /** Draft or scheduled posts a client asked to change. */
  clientChangesRequested: number;
  /** The Google listing is connected without a business location (owners only). */
  chooseGoogleLocation: boolean;
  /** Posts that failed, on one platform or all, changed in the last 7 days (as Needs you). */
  failedLast7Days: number;
  failedPlatforms: Platform[];
  needsReconnect: Platform[];
  /** R7-pages L4: can't be renewed and ends within the warning window (lib/connectionExpiry.ts). */
  endsSoon: Platform[];
  /** R7-pages L4: its end passed before the daily sweep flagged it. */
  ended: Platform[];
  /** Connected platforms, including any that need reconnecting. */
  connected: number;
  /** Anything above that this person has to act on (approvals: owners only). */
  needsAttention: boolean;
}

const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SCHEDULED: Prisma.PostJobWhereInput = { status: "scheduled" };
// The dashboard summary's AWAITING_APPROVAL, so every surface shows one
// number: a draft or scheduled row submitted and never approved (the status
// list keeps out the cancelled rows that read as "rejected").
const WAITING_FOR_APPROVAL: Prisma.PostJobWhereInput = {
  status: { in: [...APPROVAL_DECIDABLE_STATUSES] },
  submittedForApprovalAt: { not: null },
  approvedAt: null,
};
// As the dashboard summary's CLIENT_CHANGE_REQUESTED.
const CLIENT_CHANGES: Prisma.PostJobWhereInput = {
  status: { in: ["draft", "scheduled"] },
  clientChangeRequestedAt: { not: null },
};

/** The pair look-ups' columns: enough to apply each filter above in code. */
const PAIR_SELECT = {
  id: true,
  workspaceId: true,
  storyOfPostJobId: true,
  status: true,
  submittedForApprovalAt: true,
  approvedAt: true,
  clientChangeRequestedAt: true,
} as const;

type PairRow = PairableJob & {
  workspaceId: string;
  status: string;
  submittedForApprovalAt: Date | null;
  approvedAt: Date | null;
  clientChangeRequestedAt: Date | null;
};

function countsByWorkspace(groups: { workspaceId: string; _count: { _all: number } }[]): Map<string, number> {
  return new Map(groups.map((group) => [group.workspaceId, group._count._all]));
}

/** Per workspace, how many of the matching rows are Stories whose feed job matches too. */
function pairedStories(rows: PairRow[], matches: (row: PairRow) => boolean): Map<string, number> {
  const matching = rows.filter(matches);
  const kept = new Set(withoutPairedStories(matching));
  const dropped = new Map<string, number>();
  for (const row of matching) {
    if (!kept.has(row)) dropped.set(row.workspaceId, (dropped.get(row.workspaceId) ?? 0) + 1);
  }
  return dropped;
}

function hasLocation(metadata: unknown): boolean {
  const name = (metadata as { locationName?: unknown } | null | undefined)?.locationName;
  return typeof name === "string" && name.trim() !== "";
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

  const [monthGroups, scheduledGroups, approvalGroups, clientGroups, failedPosts, connections] = await Promise.all([
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
      where: { workspaceId: scope, ...SCHEDULED },
      _count: { _all: true },
    }),
    prisma.postJob.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: scope, ...WAITING_FOR_APPROVAL },
      _count: { _all: true },
    }),
    prisma.postJob.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: scope, ...CLIENT_CHANGES },
      _count: { _all: true },
    }),
    // The dashboard summary's problemsLast7Days, row by row so the failed
    // platforms come with it: a week's failures are a handful of posts.
    prisma.postJob.findMany({
      where: {
        workspaceId: scope,
        updatedAt: { gte: failedSince },
        status: { not: "cancelled" },
        OR: [{ status: "failed" }, { results: { some: { status: "failed" } } }],
      },
      select: {
        id: true,
        workspaceId: true,
        storyOfPostJobId: true,
        results: { where: { status: "failed" }, select: { platform: true } },
      },
    }),
    // At most one row per platform per workspace (@@unique), so this stays small.
    prisma.socialConnection.findMany({
      where: { workspaceId: scope },
      select: { workspaceId: true, metadata: true, ...CONNECTION_EXPIRY_SELECT },
    }),
  ]);

  // The pair rule for the grouped counts: the Story jobs any of them counted,
  // then their feed jobs; two reads whatever the number of workspaces.
  const monthIds = new Set(monthGroups.map((group) => group.postJobId));
  const stories: PairRow[] = await prisma.postJob.findMany({
    where: {
      workspaceId: scope,
      storyOfPostJobId: { not: null },
      OR: [SCHEDULED, WAITING_FOR_APPROVAL, CLIENT_CHANGES, { id: { in: [...monthIds] } }],
    },
    select: PAIR_SELECT,
  });
  const feedIds = [...new Set(stories.map((story) => story.storyOfPostJobId as string))];
  const feeds: PairRow[] = feedIds.length
    ? await prisma.postJob.findMany({ where: { workspaceId: scope, id: { in: feedIds } }, select: PAIR_SELECT })
    : [];
  const pairRows = [...feeds, ...stories];
  const pairedThisMonth = pairedStories(pairRows, (row) => monthIds.has(row.id));
  const pairedScheduled = pairedStories(pairRows, (row) => row.status === "scheduled");
  const pairedWaiting = pairedStories(
    pairRows,
    (row) =>
      (APPROVAL_DECIDABLE_STATUSES as readonly string[]).includes(row.status) &&
      row.submittedForApprovalAt != null &&
      row.approvedAt == null,
  );
  const pairedClientChanges = pairedStories(
    pairRows,
    (row) => (row.status === "draft" || row.status === "scheduled") && row.clientChangeRequestedAt != null,
  );

  const postsThisMonth = new Map<string, number>();
  for (const { workspaceId } of monthGroups) {
    if (workspaceId) postsThisMonth.set(workspaceId, (postsThisMonth.get(workspaceId) ?? 0) + 1);
  }
  const scheduled = countsByWorkspace(scheduledGroups);
  const waitingForApproval = countsByWorkspace(approvalGroups);
  const clientChanges = countsByWorkspace(clientGroups);
  const less = (counts: Map<string, number>, paired: Map<string, number>, workspaceId: string) =>
    Math.max(0, (counts.get(workspaceId) ?? 0) - (paired.get(workspaceId) ?? 0));

  const entries = memberships.map(({ role, workspace }): WorkspaceOverviewEntry => {
    const failed = failedPosts.filter((post) => post.workspaceId === workspace.id);
    const own = connections.filter((connection) => connection.workspaceId === workspace.id);
    const failedLast7Days = countPostsOnce(failed);
    const failedPlatforms = [
      ...new Set(failed.flatMap((post) => post.results.map((result) => result.platform))),
    ].sort();
    const needsReconnect = own
      .filter((connection) => connection.needsReconnect)
      .map((connection) => connection.platform)
      .sort();
    const byExpiry = (state: "ends_soon" | "ended") =>
      own
        .filter((connection) => connectionExpiryState(connection, now) === state)
        .map((connection) => connection.platform)
        .sort();
    const endsSoon = byExpiry("ends_soon");
    const ended = byExpiry("ended");
    const waiting = less(waitingForApproval, pairedWaiting, workspace.id);
    const clientChangesRequested = less(clientChanges, pairedClientChanges, workspace.id);
    // F4: a client's connect link always leaves the location unchosen, and
    // every Google post fails until an owner picks one; Needs you shows it to owners.
    const chooseGoogleLocation =
      role === "owner" &&
      own.some(
        (connection) => connection.platform === "google_business_profile" && !hasLocation(connection.metadata),
      );
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      role,
      postsThisMonth: less(postsThisMonth, pairedThisMonth, workspace.id),
      scheduled: less(scheduled, pairedScheduled, workspace.id),
      waitingForApproval: waiting,
      clientChangesRequested,
      chooseGoogleLocation,
      failedLast7Days,
      failedPlatforms,
      needsReconnect,
      endsSoon,
      ended,
      connected: own.length,
      needsAttention:
        failedLast7Days > 0 ||
        needsReconnect.length > 0 ||
        endsSoon.length > 0 ||
        ended.length > 0 ||
        // R6-client-journey L4: only an owner decides approvals (Needs you
        // gives a member no approvals row either).
        (role === "owner" && waiting > 0) ||
        clientChangesRequested > 0 ||
        chooseGoogleLocation,
    };
  });

  return entries.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
