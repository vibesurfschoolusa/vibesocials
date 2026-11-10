import type { WorkspaceRole } from "@prisma/client";

/** One workspace the deleting user belongs to, or still has rows in. */
export interface DeletionMembership {
  workspaceId: string;
  name: string;
  /**
   * The user's role, or null for a workspace they have left (or were removed
   * from) whose connections, media, posts or metrics still carry their id.
   * Those rows cascade from User too, so the workspace needs a reassignment
   * just like one the user is still in.
   */
  role: WorkspaceRole | null;
  /** Every OTHER member of the workspace, with when they joined. */
  otherMembers: { userId: string; role: WorkspaceRole; createdAt: Date }[];
}

export interface AccountDeletionPlan {
  deleteWorkspaceIds: string[];
  reassign: { workspaceId: string; toUserId: string }[];
  blocked: { workspaceId: string; name: string }[];
}

/**
 * Who receives the deleting user's rows in a workspace that survives: the
 * longest-standing other owner, else (a workspace that has somehow lost its
 * owners) the longest-standing other member, else null (nobody else is in it).
 *
 * "Longest-standing" uses the membership's createdAt: the schema keeps no
 * promotion date, so the owner who joined first wins.
 */
export function pickHeir(otherMembers: DeletionMembership["otherMembers"]): string | null {
  const owners = otherMembers.filter((member) => member.role === "owner");
  const pool = owners.length > 0 ? owners : otherMembers;
  if (pool.length === 0) {
    return null;
  }
  return pool.reduce((oldest, current) => (current.createdAt < oldest.createdAt ? current : oldest))
    .userId;
}

/**
 * Decides, before anything is changed, what deleting an account does to each
 * of the user's workspaces. Pure, so every rule is testable on its own. Every
 * workspace lands in exactly one list.
 */
export function planAccountDeletion(memberships: DeletionMembership[]): AccountDeletionPlan {
  const plan: AccountDeletionPlan = { deleteWorkspaceIds: [], reassign: [], blocked: [] };

  for (const membership of memberships) {
    const hasOtherOwner = membership.otherMembers.some((member) => member.role === "owner");

    // The only owner of a workspace others still use: it has nobody to pass to.
    if (membership.role === "owner" && !hasOtherOwner && membership.otherMembers.length > 0) {
      plan.blocked.push({ workspaceId: membership.workspaceId, name: membership.name });
      continue;
    }

    const heir = pickHeir(membership.otherMembers);
    if (heir === null) {
      // Nobody else is in it, whatever the user's role: it is theirs alone.
      plan.deleteWorkspaceIds.push(membership.workspaceId);
    } else {
      plan.reassign.push({ workspaceId: membership.workspaceId, toUserId: heir });
    }
  }

  return plan;
}
