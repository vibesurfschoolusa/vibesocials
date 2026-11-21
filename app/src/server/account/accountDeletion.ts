import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

import { POST_PUBLISHING_MESSAGE, isOnlyWorkspace, isPostPublishing } from "./deleteWorkspace";
import { planAccountDeletion, type AccountDeletionPlan, type DeletionMembership } from "./deletionPlan";

/**
 * Reads what planAccountDeletion needs for `userId`, and the same preview the
 * Settings confirmation shows. Shared by DELETE /api/auth/account and
 * src/app/settings/page.tsx so both say the same thing.
 */

/** The reads loadAccountDeletion makes: the default client, or a transaction's. */
type DeletionReadClient = Pick<
  Prisma.TransactionClient,
  "workspaceMember" | "workspace" | "socialConnection" | "mediaItem" | "postJob" | "postMetric"
>;

const OTHER_MEMBER_SELECT = { userId: true, role: true, createdAt: true } as const;

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A workspace that blocks the deletion. R61 new-customer-2 L1: `onlyWorkspace`
 * when it is the person's only membership, which Delete workspace refuses
 * ("delete your account instead"), so the sentence must not send them there.
 */
export type BlockedWorkspace = AccountDeletionPlan["blocked"][number] & { onlyWorkspace?: boolean };

export function blockedMessage(blocked: readonly BlockedWorkspace[]): string {
  const names = joinNames(blocked.map((b) => b.name));
  if (blocked.length === 1 && blocked[0].onlyWorkspace) {
    return `You are the only owner of ${names}. Make another member an owner with Make owner, or remove the other members, then try again.`;
  }
  return `You are the only owner of ${names}. Make another member an owner, or delete the workspace, then try again.`;
}

/**
 * Workspaces where this user's id is on a connection, media item, post or
 * metric. All four cascade from User, so a workspace the user has LEFT (or
 * was removed from) still loses those rows unless they are reassigned.
 */
async function workspacesWithUserRows(db: DeletionReadClient, userId: string): Promise<string[]> {
  const args = { where: { userId }, select: { workspaceId: true }, distinct: ["workspaceId" as const] };
  const results = await Promise.all([
    db.socialConnection.findMany(args),
    db.mediaItem.findMany(args),
    db.postJob.findMany(args),
    db.postMetric.findMany(args),
  ]);
  return [...new Set(results.flat().map((row) => row.workspaceId))];
}

/**
 * Pass a transaction client as `db` to read the same rows again under the
 * deletion's locks (DELETE /api/auth/account re-plans from them).
 */
export async function loadAccountDeletion(
  userId: string,
  db: DeletionReadClient = prisma,
): Promise<{ plan: AccountDeletionPlan; workspaces: DeletionMembership[] }> {
  const memberships = await db.workspaceMember.findMany({
    where: { userId },
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          members: { where: { userId: { not: userId } }, select: OTHER_MEMBER_SELECT },
        },
      },
    },
  });
  const workspaces: DeletionMembership[] = memberships.map(({ role, workspace }) => ({
    workspaceId: workspace.id,
    name: workspace.name,
    role,
    otherMembers: workspace.members,
  }));

  const memberOf = new Set(workspaces.map((w) => w.workspaceId));
  const formerIds = (await workspacesWithUserRows(db, userId)).filter((id) => !memberOf.has(id));
  if (formerIds.length > 0) {
    const former = await db.workspace.findMany({
      where: { id: { in: formerIds } },
      select: { id: true, name: true, members: { select: OTHER_MEMBER_SELECT } },
    });
    for (const workspace of former) {
      workspaces.push({
        workspaceId: workspace.id,
        name: workspace.name,
        role: null,
        otherMembers: workspace.members,
      });
    }
  }

  const plan = planAccountDeletion(workspaces);
  // R61 new-customer-2 L1: the refusal's wording reads the person's memberships
  // (former workspaces, role null, are not theirs), as Delete workspace counts them.
  if (isOnlyWorkspace(memberships.length)) {
    plan.blocked = plan.blocked.map((entry): BlockedWorkspace => ({ ...entry, onlyWorkspace: true }));
  }
  return { plan, workspaces };
}

/** Why the account cannot be deleted right now, or null. */
export async function accountDeletionRefusal(plan: AccountDeletionPlan): Promise<string | null> {
  if (plan.blocked.length > 0) return blockedMessage(plan.blocked);
  if (await isPostPublishing(plan.deleteWorkspaceIds)) return POST_PUBLISHING_MESSAGE;
  return null;
}

export interface AccountDeletionPreview {
  deleteWorkspaces: { name: string; scheduledCount: number }[];
  leaveWorkspaces: { name: string }[];
  refusal: string | null;
}

/** What deleting the account would do, for the Settings confirmation. */
export async function accountDeletionPreview(userId: string): Promise<AccountDeletionPreview> {
  const { plan, workspaces } = await loadAccountDeletion(userId);
  const deleteIds = new Set(plan.deleteWorkspaceIds);
  const blockedIds = new Set(plan.blocked.map((b) => b.workspaceId));

  const scheduled =
    deleteIds.size > 0
      ? await prisma.postJob.groupBy({
          by: ["workspaceId"],
          where: { workspaceId: { in: [...deleteIds] }, status: "scheduled" },
          _count: { _all: true },
        })
      : [];
  const scheduledBy = new Map(scheduled.map((row) => [row.workspaceId, row._count._all]));

  return {
    deleteWorkspaces: workspaces
      .filter((w) => deleteIds.has(w.workspaceId))
      .map((w) => ({ name: w.name, scheduledCount: scheduledBy.get(w.workspaceId) ?? 0 })),
    leaveWorkspaces: workspaces
      .filter((w) => w.role !== null && !deleteIds.has(w.workspaceId) && !blockedIds.has(w.workspaceId))
      .map((w) => ({ name: w.name })),
    refusal: await accountDeletionRefusal(plan),
  };
}
