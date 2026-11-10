import { describe, expect, it } from "vitest";

import { planAccountDeletion, type DeletionMembership } from "./deletionPlan";

const day = (n: number) => new Date(`2026-01-${String(n).padStart(2, "0")}T00:00:00Z`);

function membership(overrides: Partial<DeletionMembership> & { workspaceId: string }): DeletionMembership {
  return {
    name: `Workspace ${overrides.workspaceId}`,
    role: "owner",
    otherMembers: [],
    ...overrides,
  };
}

describe("planAccountDeletion", () => {
  it("deletes a personal workspace the user owns alone", () => {
    const plan = planAccountDeletion([membership({ workspaceId: "ws-personal" })]);

    expect(plan).toEqual({ deleteWorkspaceIds: ["ws-personal"], reassign: [], blocked: [] });
  });

  it("blocks a workspace where the user is the only owner and others are members", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-team",
        name: "Surf Team",
        otherMembers: [{ userId: "u-2", role: "member", createdAt: day(2) }],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: [],
      reassign: [],
      blocked: [{ workspaceId: "ws-team", name: "Surf Team" }],
    });
  });

  it("keeps a co-owned workspace and reassigns to the other owner", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-co",
        otherMembers: [
          { userId: "u-member", role: "member", createdAt: day(1) },
          { userId: "u-owner", role: "owner", createdAt: day(3) },
        ],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: [],
      reassign: [{ workspaceId: "ws-co", toUserId: "u-owner" }],
      blocked: [],
    });
  });

  it("keeps a workspace where the user is a plain member and reassigns to its owner", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-joined",
        role: "member",
        otherMembers: [{ userId: "u-boss", role: "owner", createdAt: day(5) }],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: [],
      reassign: [{ workspaceId: "ws-joined", toUserId: "u-boss" }],
      blocked: [],
    });
  });

  it("keeps a workspace the user has left but still has rows in", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-former",
        role: null,
        otherMembers: [{ userId: "u-boss", role: "owner", createdAt: day(5) }],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: [],
      reassign: [{ workspaceId: "ws-former", toUserId: "u-boss" }],
      blocked: [],
    });
  });

  it("handles a mix of all four kinds at once", () => {
    const plan = planAccountDeletion([
      membership({ workspaceId: "ws-personal" }),
      membership({
        workspaceId: "ws-team",
        name: "Surf Team",
        otherMembers: [{ userId: "u-2", role: "member", createdAt: day(2) }],
      }),
      membership({
        workspaceId: "ws-co",
        otherMembers: [{ userId: "u-3", role: "owner", createdAt: day(2) }],
      }),
      membership({
        workspaceId: "ws-joined",
        role: "member",
        otherMembers: [{ userId: "u-4", role: "owner", createdAt: day(2) }],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: ["ws-personal"],
      reassign: [
        { workspaceId: "ws-co", toUserId: "u-3" },
        { workspaceId: "ws-joined", toUserId: "u-4" },
      ],
      blocked: [{ workspaceId: "ws-team", name: "Surf Team" }],
    });
  });

  it("reassigns to the longest-standing other owner", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-co",
        otherMembers: [
          { userId: "u-new-owner", role: "owner", createdAt: day(9) },
          { userId: "u-old-member", role: "member", createdAt: day(1) },
          { userId: "u-old-owner", role: "owner", createdAt: day(4) },
          { userId: "u-mid-owner", role: "owner", createdAt: day(6) },
        ],
      }),
    ]);

    expect(plan.reassign).toEqual([{ workspaceId: "ws-co", toUserId: "u-old-owner" }]);
  });

  it("plans nothing for a user with no workspaces", () => {
    expect(planAccountDeletion([])).toEqual({ deleteWorkspaceIds: [], reassign: [], blocked: [] });
  });
});
