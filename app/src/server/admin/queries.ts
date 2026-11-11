import { Prisma, type Platform } from "@prisma/client";

import { billingEnabled, planState, type PlanState } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { PLATFORM_ORDER } from "@/lib/platforms";
import { resolveWorkspaceLimits, type WorkspaceLimits } from "@/lib/usageLimits";
import { getWorkspaceUsageOrNull, type WorkspaceUsage } from "@/server/usage/workspaceUsage";

import { LIMIT_FIELDS, type LimitField } from "./actions";

/**
 * What /admin reads (2026-11-10). Crosses every workspace boundary, so it
 * selects only what the page shows: names, dates, owners' emails and counts.
 * Never a caption, a media file, a link token or anything of a connection but
 * its platform and whether it needs reconnecting. The counts are grouped
 * queries bounded to the workspaces on the page, never one query per row.
 */

export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_SEARCH_MAX_LENGTH = 100;
export const ADMIN_ACTIONS_SHOWN = 50;
const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AdminWorkspaceRow = {
  id: string;
  name: string;
  createdAt: Date;
  ownerEmails: string[];
  memberCount: number;
  /** Connected platforms, in the app's platform order. */
  platforms: Platform[];
  /** How many of those need reconnecting. */
  reconnectCount: number;
  published30d: number;
  failed30d: number;
  storageBytes: number;
  pausedAt: Date | null;
  /** 21a: the state the plan columns give, whether or not billing is on. */
  planState: PlanState;
};

const OWNERS_SELECT = {
  where: { role: "owner" },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  select: { user: { select: { email: true } } },
} satisfies Prisma.Workspace$membersArgs;

type Counts = Omit<AdminWorkspaceRow, "id" | "name" | "createdAt" | "ownerEmails" | "pausedAt" | "planState">;

/** 21a: the plan columns, read on both admin pages billing on or off. */
const BILLING_SELECT = {
  billingExempt: true,
  plan: true,
  planStatus: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
} satisfies Prisma.WorkspaceSelect;

type BillingColumns = Prisma.WorkspaceGetPayload<{ select: typeof BILLING_SELECT }>;

/** Members, connections, recent outcomes and storage for these workspaces, one query each. */
async function countsFor(ids: string[], now: Date): Promise<Map<string, Counts>> {
  const counts = new Map<string, Counts>(
    ids.map((id) => [
      id,
      { memberCount: 0, platforms: [], reconnectCount: 0, published30d: 0, failed30d: 0, storageBytes: 0 },
    ]),
  );
  if (ids.length === 0) return counts;

  const [members, connections, outcomes, storage] = await Promise.all([
    prisma.workspaceMember.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.socialConnection.groupBy({
      by: ["workspaceId", "platform", "needsReconnect"],
      where: { workspaceId: { in: ids } },
    }),
    prisma.postJob.groupBy({
      by: ["workspaceId", "status"],
      where: {
        workspaceId: { in: ids },
        status: { in: ["completed", "failed"] },
        updatedAt: { gte: new Date(now.getTime() - RECENT_DAYS * DAY_MS) },
      },
      _count: { _all: true },
    }),
    // Summed as bigint, as workspaceUsage.ts does: a total can pass the Int range.
    prisma.$queryRaw<{ workspaceId: string; total: bigint | number | null }[]>`
      SELECT "workspaceId", COALESCE(SUM("sizeBytes"), 0)::bigint AS "total"
      FROM "MediaItem"
      WHERE "workspaceId" IN (${Prisma.join(ids)}) AND "deletedAt" IS NULL
      GROUP BY "workspaceId"`,
  ]);

  for (const row of members) {
    const entry = counts.get(row.workspaceId);
    if (entry) entry.memberCount = row._count._all;
  }
  const platformSets = new Map<string, Set<Platform>>();
  for (const row of connections) {
    const entry = counts.get(row.workspaceId);
    if (!entry) continue;
    const set = platformSets.get(row.workspaceId) ?? new Set<Platform>();
    set.add(row.platform);
    platformSets.set(row.workspaceId, set);
    if (row.needsReconnect) entry.reconnectCount += 1;
  }
  for (const [workspaceId, set] of platformSets) {
    const entry = counts.get(workspaceId);
    if (entry) entry.platforms = PLATFORM_ORDER.filter((platform) => set.has(platform));
  }
  for (const row of outcomes) {
    const entry = counts.get(row.workspaceId);
    if (!entry) continue;
    if (row.status === "completed") entry.published30d = row._count._all;
    if (row.status === "failed") entry.failed30d = row._count._all;
  }
  for (const row of storage) {
    const entry = counts.get(row.workspaceId);
    if (entry) entry.storageBytes = Number(row.total ?? 0);
  }
  return counts;
}

function toRow(
  workspace: {
    id: string;
    name: string;
    createdAt: Date;
    pausedAt: Date | null;
    members: { user: { email: string } }[];
  } & BillingColumns,
  counts: Counts | undefined,
  now: Date,
): AdminWorkspaceRow {
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    ownerEmails: workspace.members.map((member) => member.user.email),
    memberCount: counts?.memberCount ?? 0,
    platforms: counts?.platforms ?? [],
    reconnectCount: counts?.reconnectCount ?? 0,
    published30d: counts?.published30d ?? 0,
    failed30d: counts?.failed30d ?? 0,
    storageBytes: counts?.storageBytes ?? 0,
    pausedAt: workspace.pausedAt,
    planState: planState(workspace, now),
  };
}

/** Name or an owner's email contains the text, ignoring case. Nothing else is searched. */
function searchWhere(search: string): Prisma.WorkspaceWhereInput {
  const text = search.trim().slice(0, ADMIN_SEARCH_MAX_LENGTH);
  if (!text) return {};
  return {
    OR: [
      { name: { contains: text, mode: "insensitive" } },
      { members: { some: { role: "owner", user: { email: { contains: text, mode: "insensitive" } } } } },
    ],
  };
}

export async function listAdminWorkspaces(args: {
  search: string;
  /** Zero-based. */
  page: number;
  now: Date;
}): Promise<{ rows: AdminWorkspaceRow[]; hasNextPage: boolean }> {
  const page = Number.isSafeInteger(args.page) && args.page > 0 ? args.page : 0;
  const found = await prisma.workspace.findMany({
    where: searchWhere(args.search),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: page * ADMIN_PAGE_SIZE,
    // One more than a page, to know whether there is a next one.
    take: ADMIN_PAGE_SIZE + 1,
    select: { id: true, name: true, createdAt: true, pausedAt: true, ...BILLING_SELECT, members: OWNERS_SELECT },
  });
  const shown = found.slice(0, ADMIN_PAGE_SIZE);
  const counts = await countsFor(
    shown.map((workspace) => workspace.id),
    args.now,
  );
  return {
    rows: shown.map((workspace) => toRow(workspace, counts.get(workspace.id), args.now)),
    hasNextPage: found.length > ADMIN_PAGE_SIZE,
  };
}

export type AdminActionEntry = {
  id: string;
  createdAt: Date;
  operatorEmail: string;
  action: string;
  detail: Prisma.JsonValue;
};

export type AdminWorkspaceDetail = {
  workspace: AdminWorkspaceRow;
  pausedReason: string | null;
  /** 21a: the stored plan fields, the state they give, and whether billing is on (enforced). */
  billing: BillingColumns & { state: PlanState; enabled: boolean };
  /** The override columns as stored; null means the default applies. */
  overrides: Record<LimitField, number | null>;
  effectiveLimits: WorkspaceLimits;
  /** What the workspace would get with no overrides (its plan with billing on, else environment, else built-in). */
  defaultLimits: WorkspaceLimits;
  /** Null when it could not be read; the page still renders. */
  usage: WorkspaceUsage | null;
  actions: AdminActionEntry[];
};

export async function getAdminWorkspaceDetail(id: string, now: Date): Promise<AdminWorkspaceDetail | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      pausedAt: true,
      pausedReason: true,
      limitPostsPerDay: true,
      limitXPostsPerMonth: true,
      limitYoutubeUploadsPerDay: true,
      limitStorageMb: true,
      ...BILLING_SELECT,
      members: OWNERS_SELECT,
    },
  });
  if (!workspace) return null;

  const [counts, usage, actions] = await Promise.all([
    countsFor([workspace.id], now),
    getWorkspaceUsageOrNull(workspace.id, now),
    prisma.adminAction.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_ACTIONS_SHOWN,
      select: { id: true, createdAt: true, operatorEmail: true, action: true, detail: true },
    }),
  ]);

  const overrides = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, workspace[field]])) as Record<
    LimitField,
    number | null
  >;

  const row = toRow(workspace, counts.get(workspace.id), now);
  const billingColumns: BillingColumns = {
    billingExempt: workspace.billingExempt,
    plan: workspace.plan,
    planStatus: workspace.planStatus,
    trialEndsAt: workspace.trialEndsAt,
    currentPeriodEnd: workspace.currentPeriodEnd,
  };
  // The limits resolve with the plan only with billing on, exactly as enforced.

  return {
    workspace: row,
    pausedReason: workspace.pausedReason,
    billing: { ...billingColumns, state: row.planState, enabled: billingEnabled() },
    overrides,
    effectiveLimits: resolveWorkspaceLimits({ ...overrides, ...billingColumns }, process.env, now),
    defaultLimits: resolveWorkspaceLimits(billingColumns, process.env, now),
    usage,
    actions,
  };
}
