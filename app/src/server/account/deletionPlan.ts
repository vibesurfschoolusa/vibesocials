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
 * Decides, before anything is changed, what deleting an account does to each
 * of the user's workspaces. Pure, so every rule is testable on its own.
 *
 * "Longest-standing owner" uses the membership's createdAt: the schema keeps
 * no promotion date, so the owner who joined first wins.
 */
export function planAccountDeletion(memberships: DeletionMembership[]): AccountDeletionPlan {
  const plan: AccountDeletionPlan = { deleteWorkspaceIds: [], reassign: [], blocked: [] };

  for (const membership of memberships) {
    const otherOwners = membership.otherMembers.filter((member) => member.role === "owner");

    if (membership.role === "owner" && otherOwners.length === 0) {
      if (membership.otherMembers.length === 0) {
        plan.deleteWorkspaceIds.push(membership.workspaceId);
      } else {
        plan.blocked.push({ workspaceId: membership.workspaceId, name: membership.name });
      }
      continue;
    }

    // Every workspace keeps at least one owner (the leave and demote routes
    // enforce it), so a surviving workspace always has one to hand rows to.
    if (otherOwners.length === 0) {
      continue;
    }
    const longest = otherOwners.reduce((oldest, current) =>
      current.createdAt < oldest.createdAt ? current : oldest,
    );
    plan.reassign.push({ workspaceId: membership.workspaceId, toUserId: longest.userId });
  }

  return plan;
}
