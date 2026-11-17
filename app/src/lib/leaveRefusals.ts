// The leave route's refusals, shown as they are by the Team card's Leave
// (answerFailureText). A plain module: route files may export only handlers.

/**
 * R33 lead review: Leave can be pressed before the members list loads, so a
 * sole owner can reach this. It names the card's own control, Make owner,
 * which shows in the members list once the page has loaded it.
 */
export const LEAVE_SOLE_OWNER_MESSAGE =
  "You're the only owner. Reload the page, make another member an owner with Make owner, then leave.";

/**
 * R34 pages L3: a sole owner with nobody else in the workspace (every personal
 * workspace) has no member to make an owner, so the ways out are inviting
 * someone first or deleting the workspace.
 */
export const LEAVE_ONLY_PERSON_MESSAGE =
  "You're the only person in this workspace. Invite someone and make them an owner, or delete the workspace.";

/** The membership was already gone (left or removed in another tab). */
export const LEAVE_NOT_MEMBER_MESSAGE = "You're no longer a member of this workspace. Reload the page.";
