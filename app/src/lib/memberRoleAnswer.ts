// The members route's answer to Make member, from the roles it read inside the
// ws-owners lock. A plain module: route files may export only handlers.
// Client-safe: no server or database imports.

import { soleOwnerDemoteRefusal } from "./leaveRefusals";

type Role = "owner" | "member";

/** What the route read inside its lock. A role of null means that person is no longer in the workspace. */
export interface DemoteFacts {
  /** The caller is demoting themselves. */
  self: boolean;
  callerRole: Role | null;
  targetRole: Role | null;
  ownerCount: number;
  /** Everyone in the workspace except the target. */
  otherMembers: number;
}

export type DemoteAnswer =
  | { kind: "demote" }
  | { kind: "gone" }
  | { kind: "your_role_changed"; error: string }
  | { kind: "their_role_changed"; error: string }
  | { kind: "last_owner"; error: string };

export const YOUR_ROLE_CHANGED_MESSAGE = "Your role changed in the meantime. Reload the page to see the current members.";

export const THEIR_ROLE_CHANGED_MESSAGE = "Their role changed in the meantime. Reload the page to see the current members.";

/**
 * R37 security L1 / client-journey L4: decided from the current roles, so a
 * co-owner who stepped down at the same moment is "their role changed", not
 * "you're the only owner", and a caller demoted meanwhile hears about their
 * own role. The last-owner refusal is reachable only on the caller's own Make
 * member: two distinct owners always count at least two.
 */
export function demoteAnswer(facts: DemoteFacts): DemoteAnswer {
  if (facts.callerRole !== "owner") return { kind: "your_role_changed", error: YOUR_ROLE_CHANGED_MESSAGE };
  if (!facts.self) {
    if (facts.targetRole === null) return { kind: "gone" };
    if (facts.targetRole !== "owner") return { kind: "their_role_changed", error: THEIR_ROLE_CHANGED_MESSAGE };
  }
  if (facts.ownerCount < 2) return { kind: "last_owner", error: soleOwnerDemoteRefusal(facts.otherMembers) };
  return { kind: "demote" };
}
