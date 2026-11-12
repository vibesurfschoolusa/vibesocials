import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, loadAccountDeletionMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  loadAccountDeletionMock: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: findManyMock } } }));
vi.mock("@/server/account/accountDeletion", () => ({ loadAccountDeletion: loadAccountDeletionMock }));

import { accountDeletionCancelsPaidPlan, workspacesHavePaidPlan } from "./paidPlans";

/** S1 item 8: whether a delete dialog says that a paid plan is cancelled. */

beforeEach(() => {
  findManyMock.mockReset();
  loadAccountDeletionMock.mockReset();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspacesHavePaidPlan", () => {
  it("reads nothing without the Stripe key (deletion cancels nothing then)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
    expect(await workspacesHavePaidPlan(["ws-1"])).toBe(false);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("reads nothing for no workspaces", async () => {
    expect(await workspacesHavePaidPlan([])).toBe(false);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("is true for a plan whose subscription is live, scoped to the given workspaces", async () => {
    findManyMock.mockResolvedValue([{ planStatus: "past_due" }]);
    expect(await workspacesHavePaidPlan(["ws-1", "ws-2"])).toBe(true);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["ws-1", "ws-2"] }, plan: { not: null } },
      select: { planStatus: true },
    });
  });

  it("is false for a cancelled plan or none", async () => {
    findManyMock.mockResolvedValue([{ planStatus: "canceled" }]);
    expect(await workspacesHavePaidPlan(["ws-1"])).toBe(false);
    findManyMock.mockResolvedValue([]);
    expect(await workspacesHavePaidPlan(["ws-1"])).toBe(false);
  });
});

describe("accountDeletionCancelsPaidPlan", () => {
  it("asks about the workspaces the deletion would delete only", async () => {
    loadAccountDeletionMock.mockResolvedValue({ plan: { deleteWorkspaceIds: ["ws-9"] }, workspaces: [] });
    findManyMock.mockResolvedValue([{ planStatus: "active" }]);
    expect(await accountDeletionCancelsPaidPlan("user-1")).toBe(true);
    expect(loadAccountDeletionMock).toHaveBeenCalledWith("user-1");
    expect(findManyMock.mock.calls[0][0].where.id).toEqual({ in: ["ws-9"] });
  });

  it("reads nothing without the Stripe key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
    expect(await accountDeletionCancelsPaidPlan("user-1")).toBe(false);
    expect(loadAccountDeletionMock).not.toHaveBeenCalled();
  });
});
