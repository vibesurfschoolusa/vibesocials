// The leave route's refusals, shown as they are by the Team card's Leave
// (answerFailureText). A plain module: route files may export only handlers.
// Client-safe: the Team card imports it, so no server or database imports.

/** Why a sole owner may not leave, by who else is there to take over. */
export type SoleOwnerLeaveCase = "sole_owner" | "only_person" | "only_workspace";

/**
 * R35 client-journey L1: the one rule for a sole owner's way out, used by the
 * leave route (counted inside its lock) and the Team card (counted from its
 * loaded list), so the two name the same step. `otherMembers` leaves out the
 * caller; `onlyWorkspace` is isOnlyWorkspace (server/account/deleteWorkspace.ts)
 * of the caller's memberships: in the only workspace, Delete workspace refuses.
 */
export function soleOwnerLeaveCase({
  otherMembers,
  onlyWorkspace,
}: {
  otherMembers: number;
  onlyWorkspace: boolean;
}): SoleOwnerLeaveCase {
  if (otherMembers > 0) return "sole_owner";
  return onlyWorkspace ? "only_workspace" : "only_person";
}

const SOLE_OWNER_STEPS: Record<SoleOwnerLeaveCase, string> = {
  // R33 lead review: names the card's own control, Make owner.
  sole_owner: "You're the only owner. Make another member an owner with Make owner, then leave.",
  // R34 pages L3: nobody to make an owner; the card's Delete this workspace is below Leave.
  only_person:
    "You're the only person in this workspace. Invite someone and make them an owner, or delete it with Delete this workspace.",
  // Lead review (R34): Delete workspace refuses the last workspace, so Settings, Account, Delete account.
  only_workspace:
    "You're the only person in this workspace, and it's your only one. Invite someone and make them an owner, or delete your account with Delete account under Account in Settings.",
};

/** The Team card's line under a disabled Leave: the list it counted from is on screen. */
export function soleOwnerLeaveStep(soleOwner: SoleOwnerLeaveCase): string {
  return SOLE_OWNER_STEPS[soleOwner];
}

/**
 * The leave route's refusal. Leave can be pressed before the members list
 * loads, so Make owner may not be on screen yet: that one says to reload.
 */
export function soleOwnerLeaveRefusal(soleOwner: SoleOwnerLeaveCase): string {
  return soleOwner === "sole_owner" ? LEAVE_SOLE_OWNER_MESSAGE : SOLE_OWNER_STEPS[soleOwner];
}

export const LEAVE_SOLE_OWNER_MESSAGE =
  "You're the only owner. Reload the page, make another member an owner with Make owner, then leave.";

export const LEAVE_ONLY_PERSON_MESSAGE = SOLE_OWNER_STEPS.only_person;

export const LEAVE_ONLY_WORKSPACE_MESSAGE = SOLE_OWNER_STEPS.only_workspace;

/** The membership was already gone (left or removed in another tab). */
export const LEAVE_NOT_MEMBER_MESSAGE = "You're no longer a member of this workspace. Reload the page.";

/**
 * R36 lead review: the members route's refusal of the last owner's own Make
 * member (a co-owner left or stepped down in another tab), by the same rule:
 * with others here, one of them can be made an owner; alone, nobody can.
 * `otherMembers` leaves out the caller, counted inside the route's lock.
 */
export function soleOwnerDemoteRefusal(otherMembers: number): string {
  return soleOwnerLeaveCase({ otherMembers, onlyWorkspace: false }) === "sole_owner"
    ? DEMOTE_SOLE_OWNER_MESSAGE
    : DEMOTE_ONLY_PERSON_MESSAGE;
}

export const DEMOTE_SOLE_OWNER_MESSAGE =
  "You're the only owner. Reload the page, make another member an owner with Make owner, then try again.";

export const DEMOTE_ONLY_PERSON_MESSAGE = "You're the only person in this workspace, so you stay its owner.";
