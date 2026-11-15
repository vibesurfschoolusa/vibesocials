/**
 * R9-client-journey L6: an invite link works only while the person who made it
 * is still an owner of its workspace. Demoting or leaving revokes their links
 * now, but links made before that (#151) were never revoked, so the preview
 * and Join both check the maker. A 404 like a dead link, so the join page
 * shows its invalid-link state.
 */
export const MAKER_NOT_OWNER_MESSAGE = "This invite link is no longer active. Ask an owner for a new one.";

/** The client the maker check reads with: the shared client or a transaction. */
interface MemberCounter {
  workspaceMember: { count(args: { where: { workspaceId: string; userId: string; role: "owner" } }): Promise<number> };
}

/**
 * R10-client-journey L3: whether an invite link still works, by the rule the
 * preview and Join apply: not revoked, not expired, and its maker still an
 * owner of its workspace. The Team card shows only such a link, so it offers
 * Create instead of one that would be refused.
 */
export async function inviteLinkWorks(
  db: MemberCounter,
  invite: { workspaceId: string; createdById: string; revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): Promise<boolean> {
  if (invite.revokedAt || invite.expiresAt <= now) return false;
  const owners = await db.workspaceMember.count({
    where: { workspaceId: invite.workspaceId, userId: invite.createdById, role: "owner" },
  });
  return owners > 0;
}
