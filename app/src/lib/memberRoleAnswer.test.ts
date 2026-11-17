import { describe, expect, it } from "vitest";

import { DEMOTE_ONLY_PERSON_MESSAGE, DEMOTE_SOLE_OWNER_MESSAGE } from "./leaveRefusals";
import {
  THEIR_ROLE_CHANGED_MESSAGE,
  YOUR_ROLE_CHANGED_MESSAGE,
  demoteAnswer,
  type DemoteAnswer,
  type DemoteFacts,
} from "./memberRoleAnswer";

// R37 security L1 / client-journey L4 / pages L3: the members route's Make
// member is decided from the roles read inside its lock, by one rule.
const CASES: Array<[string, DemoteFacts, DemoteAnswer]> = [
  [
    "the caller was made a member meanwhile",
    { self: false, callerRole: "member", targetRole: "owner", ownerCount: 1, otherMembers: 1 },
    { kind: "your_role_changed", error: YOUR_ROLE_CHANGED_MESSAGE },
  ],
  [
    "the caller was made a member meanwhile, on their own Make member",
    { self: true, callerRole: "member", targetRole: "member", ownerCount: 1, otherMembers: 1 },
    { kind: "your_role_changed", error: YOUR_ROLE_CHANGED_MESSAGE },
  ],
  [
    "the caller left meanwhile",
    { self: false, callerRole: null, targetRole: "owner", ownerCount: 1, otherMembers: 1 },
    { kind: "your_role_changed", error: YOUR_ROLE_CHANGED_MESSAGE },
  ],
  [
    "the target stepped down meanwhile (the caller is now the only owner)",
    { self: false, callerRole: "owner", targetRole: "member", ownerCount: 1, otherMembers: 1 },
    { kind: "their_role_changed", error: THEIR_ROLE_CHANGED_MESSAGE },
  ],
  [
    "the target left meanwhile",
    { self: false, callerRole: "owner", targetRole: null, ownerCount: 1, otherMembers: 1 },
    { kind: "gone" },
  ],
  [
    "the real last owner on their own Make member, with others here",
    { self: true, callerRole: "owner", targetRole: "owner", ownerCount: 1, otherMembers: 2 },
    { kind: "last_owner", error: DEMOTE_SOLE_OWNER_MESSAGE },
  ],
  [
    "the real last owner on their own Make member, alone",
    { self: true, callerRole: "owner", targetRole: "owner", ownerCount: 1, otherMembers: 0 },
    { kind: "last_owner", error: DEMOTE_ONLY_PERSON_MESSAGE },
  ],
  [
    "a co-owner demoted",
    { self: false, callerRole: "owner", targetRole: "owner", ownerCount: 2, otherMembers: 1 },
    { kind: "demote" },
  ],
  [
    "stepping down with another owner here",
    { self: true, callerRole: "owner", targetRole: "owner", ownerCount: 2, otherMembers: 1 },
    { kind: "demote" },
  ],
];

describe("demoteAnswer", () => {
  it.each(CASES)("%s", (_label, facts, answer) => {
    expect(demoteAnswer(facts)).toEqual(answer);
  });

  it("the sentences", () => {
    expect(YOUR_ROLE_CHANGED_MESSAGE).toBe("Your role changed in the meantime. Reload the page to see the current members.");
    expect(THEIR_ROLE_CHANGED_MESSAGE).toBe("Their role changed in the meantime. Reload the page to see the current members.");
    expect(DEMOTE_ONLY_PERSON_MESSAGE).toBe(
      "You're the only person in this workspace, so you stay its owner. Reload the page to see the current members.",
    );
  });
});
