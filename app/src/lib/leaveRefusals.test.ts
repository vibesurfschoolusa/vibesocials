import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEAVE_ONLY_PERSON_MESSAGE,
  LEAVE_ONLY_WORKSPACE_MESSAGE,
  LEAVE_SOLE_OWNER_MESSAGE,
  soleOwnerLeaveCase,
  soleOwnerLeaveRefusal,
  soleOwnerLeaveStep,
} from "./leaveRefusals";

// R35 client-journey L1: one rule for a sole owner's way out, used by the
// leave route (its refusal) and the Team card (the line under Leave).
describe("a sole owner's way out of a workspace", () => {
  it("other members but no other owner: Make owner", () => {
    expect(soleOwnerLeaveCase({ otherMembers: 2, onlyWorkspace: true })).toBe("sole_owner");
    expect(soleOwnerLeaveCase({ otherMembers: 1, onlyWorkspace: false })).toBe("sole_owner");
    expect(soleOwnerLeaveStep("sole_owner")).toBe(
      "You're the only owner. Make another member an owner with Make owner, then leave.",
    );
    // The route may be answering a page that has not loaded the list yet.
    expect(soleOwnerLeaveRefusal("sole_owner")).toBe(LEAVE_SOLE_OWNER_MESSAGE);
    expect(LEAVE_SOLE_OWNER_MESSAGE).toBe(
      "You're the only owner. Reload the page, make another member an owner with Make owner, then leave.",
    );
  });

  it("alone, with other workspaces: invite someone, or Delete this workspace", () => {
    expect(soleOwnerLeaveCase({ otherMembers: 0, onlyWorkspace: false })).toBe("only_person");
    expect(soleOwnerLeaveStep("only_person")).toBe(
      "You're the only person in this workspace. Invite someone and make them an owner, or delete it with Delete this workspace.",
    );
    expect(soleOwnerLeaveRefusal("only_person")).toBe(LEAVE_ONLY_PERSON_MESSAGE);
    expect(LEAVE_ONLY_PERSON_MESSAGE).toBe(soleOwnerLeaveStep("only_person"));
  });

  it("alone, in the only workspace: invite someone, or Delete account under Account in Settings", () => {
    expect(soleOwnerLeaveCase({ otherMembers: 0, onlyWorkspace: true })).toBe("only_workspace");
    expect(soleOwnerLeaveStep("only_workspace")).toBe(
      "You're the only person in this workspace, and it's your only one. Invite someone and make them an owner, or delete your account with Delete account under Account in Settings.",
    );
    expect(soleOwnerLeaveRefusal("only_workspace")).toBe(LEAVE_ONLY_WORKSPACE_MESSAGE);
    expect(LEAVE_ONLY_WORKSPACE_MESSAGE).toBe(soleOwnerLeaveStep("only_workspace"));
  });

  it("stays client-safe: no server or database import", () => {
    const source = readFileSync(join(__dirname, "leaveRefusals.ts"), "utf8");
    expect(source).not.toMatch(/from "@\/server|from "@\/lib\/db"|from "@prisma\/client"|server-only/);
  });

  it("the controls the sentences name are on the Team card", () => {
    const card = readFileSync(join(__dirname, "../components/team-section.tsx"), "utf8");
    expect(card).toMatch(/>\s+Make owner\s+<\/Button>/);
    expect(card).toMatch(/>\s+Delete this workspace\s+<\/Button>/);
  });
});
