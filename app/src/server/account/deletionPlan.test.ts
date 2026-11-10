import { describe, expect, it } from "vitest";

import { planAccountDeletion, samePlan, type DeletionMembership } from "./deletionPlan";

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

  it("reassigns to the longest-standing other member when a joined workspace has no owner", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-ownerless",
        role: "member",
        otherMembers: [
          { userId: "u-late", role: "member", createdAt: day(7) },
          { userId: "u-early", role: "member", createdAt: day(3) },
        ],
      }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: [],
      reassign: [{ workspaceId: "ws-ownerless", toUserId: "u-early" }],
      blocked: [],
    });
  });

  it("reassigns to a member of a workspace the user left that has no owner", () => {
    const plan = planAccountDeletion([
      membership({
        workspaceId: "ws-former",
        role: null,
        otherMembers: [{ userId: "u-member", role: "member", createdAt: day(2) }],
      }),
    ]);

    expect(plan.reassign).toEqual([{ workspaceId: "ws-former", toUserId: "u-member" }]);
    expect(plan.deleteWorkspaceIds).toEqual([]);
  });

  it("deletes a workspace that has nobody else in it, whatever the user's role", () => {
    const plan = planAccountDeletion([
      membership({ workspaceId: "ws-member-alone", role: "member" }),
      membership({ workspaceId: "ws-former-empty", role: null }),
    ]);

    expect(plan).toEqual({
      deleteWorkspaceIds: ["ws-member-alone", "ws-former-empty"],
      reassign: [],
      blocked: [],
    });
  });

  it("puts every workspace in exactly one list", () => {
    const roles = ["owner", "member", null] as const;
    const others = [
      [],
      [{ userId: "u-o", role: "owner" as const, createdAt: day(1) }],
      [{ userId: "u-m", role: "member" as const, createdAt: day(1) }],
    ];
    const memberships = roles.flatMap((role, r) =>
      others.map((otherMembers, o) => membership({ workspaceId: `ws-${r}-${o}`, role, otherMembers })),
    );

    const plan = planAccountDeletion(memberships);

    const placed = [
      ...plan.deleteWorkspaceIds,
      ...plan.reassign.map((entry) => entry.workspaceId),
      ...plan.blocked.map((entry) => entry.workspaceId),
    ];
    expect(placed.sort()).toEqual(memberships.map((entry) => entry.workspaceId).sort());
  });

  it("plans nothing for a user with no workspaces", () => {
    expect(planAccountDeletion([])).toEqual({ deleteWorkspaceIds: [], reassign: [], blocked: [] });
  });
});

describe("samePlan", () => {
  const base = {
    deleteWorkspaceIds: ["ws-a", "ws-b"],
    reassign: [
      { workspaceId: "ws-c", toUserId: "u-1" },
      { workspaceId: "ws-d", toUserId: "u-2" },
    ],
    blocked: [{ workspaceId: "ws-e", name: "E" }],
  };

  it("is true for the same plan in any order", () => {
    expect(
      samePlan(base, {
        deleteWorkspaceIds: ["ws-b", "ws-a"],
        reassign: [...base.reassign].reverse(),
        blocked: [{ workspaceId: "ws-e", name: "E renamed" }],
      }),
    ).toBe(true);
  });

  it("is false for a different delete list, heir, block or extra workspace", () => {
    expect(samePlan(base, { ...base, deleteWorkspaceIds: ["ws-a"] })).toBe(false);
    expect(
      samePlan(base, { ...base, reassign: [base.reassign[0], { workspaceId: "ws-d", toUserId: "u-9" }] }),
    ).toBe(false);
    expect(samePlan(base, { ...base, blocked: [] })).toBe(false);
    expect(
      samePlan(base, { ...base, reassign: [...base.reassign, { workspaceId: "ws-new", toUserId: "u-1" }] }),
    ).toBe(false);
  });
});
