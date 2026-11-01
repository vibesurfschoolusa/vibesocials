/** Shown to the owner when removing a member invalidated the invite link. */
export const INVITE_RESET_NOTICE = "Invite link reset — create a new one to invite more people.";

export interface MemberRemovalOutcome {
  /** True when the owner's displayed invite link is now dead and must be cleared. */
  clearInvite: boolean;
  /** Extra message for the owner, or null when there's nothing to add. */
  notice: string | null;
}

/**
 * Interprets the success body of `DELETE /api/workspaces/members/[userId]`.
 * Removing a member revokes the workspace's active invite links server-side
 * (so they can't rejoin with the link they already hold); when it revoked any
 * (`invitesRevoked > 0`) the team page must drop the link it is displaying and
 * tell the owner. Anything unexpected (no field, wrong type, unparseable body)
 * is treated as "nothing revoked" — never as an error, the removal succeeded.
 */
export function memberRemovalOutcome(body: unknown): MemberRemovalOutcome {
  const revoked =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { invitesRevoked?: unknown }).invitesRevoked
      : undefined;

  if (typeof revoked === "number" && revoked > 0) {
    return { clearInvite: true, notice: INVITE_RESET_NOTICE };
  }
  return { clearInvite: false, notice: null };
}
