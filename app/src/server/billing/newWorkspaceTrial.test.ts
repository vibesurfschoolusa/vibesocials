import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planState } from "@/lib/billing";
import { workspaceBlock } from "@/lib/workspaceStatus";

import { newWorkspaceBillingData, type TrialClient } from "./newWorkspaceTrial";

/**
 * Fix round 1: what a new workspace is created with. One trial window per
 * person, from the first workspace they create with billing on; an operator's
 * workspace is exempt; with billing off, nothing.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A fake User table of one row, with the conditional update Postgres would do. */
function fakeTx(user: { email: string; emailVerifiedAt: Date | null; trialStartedAt: Date | null } | null) {
  const row = user ? { ...user } : null;
  const findUnique = vi.fn(async () => (row ? { ...row } : null));
  const updateMany = vi.fn(async ({ where, data }: { where: { trialStartedAt: null }; data: { trialStartedAt: Date } }) => {
    if (!row || row.trialStartedAt !== where.trialStartedAt) return { count: 0 };
    row.trialStartedAt = data.trialStartedAt;
    return { count: 1 };
  });
  // Cast: the fake implements only what newWorkspaceBillingData calls, not Prisma's full return types.
  return { tx: { user: { findUnique, updateMany } } as unknown as TrialClient, row, findUnique, updateMany };
}

const CUSTOMER = { email: "ann@example.com", emailVerifiedAt: null, trialStartedAt: null };

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_TRIAL_DAYS", "");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("newWorkspaceBillingData", () => {
  it("with billing off, writes nothing and reads nothing", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const { tx, findUnique, updateMany } = fakeTx(CUSTOMER);
    expect(await newWorkspaceBillingData(tx, "user-1", NOW)).toEqual({});
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a new user's first workspace: a trial of N days, and trialStartedAt set to now", async () => {
    vi.stubEnv("BILLING_TRIAL_DAYS", "10");
    const { tx, row, updateMany } = fakeTx(CUSTOMER);
    const data = await newWorkspaceBillingData(tx, "user-1", NOW);
    expect(data).toEqual({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + 10 * DAY) });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", trialStartedAt: null },
      data: { trialStartedAt: NOW },
    });
    expect(row?.trialStartedAt).toEqual(NOW);
    expect(planState(data, NOW)).toBe("trial");
  });

  it("a second workspace 5 days later ends its trial on the same day as the first", async () => {
    const { tx } = fakeTx(CUSTOMER);
    const first = await newWorkspaceBillingData(tx, "user-1", NOW);
    const second = await newWorkspaceBillingData(tx, "user-1", new Date(NOW.getTime() + 5 * DAY));
    expect(second.trialEndsAt).toEqual(first.trialEndsAt);
    expect(planState(second, new Date(NOW.getTime() + 5 * DAY))).toBe("trial");
  });

  it("a workspace created after the window is ended at once, with the trial sentence", async () => {
    const { tx } = fakeTx({ ...CUSTOMER, trialStartedAt: new Date(NOW.getTime() - 20 * DAY) });
    const data = await newWorkspaceBillingData(tx, "user-1", NOW);
    expect(data).toEqual({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() - 6 * DAY) });
    expect(planState(data, NOW)).toBe("ended");
    expect(workspaceBlock(data, NOW)?.message).toBe(
      "Your free trial has ended. Choose a plan in Settings to keep posting.",
    );
  });

  it("deleting a workspace does not reset the window: trialStartedAt lives on the user", async () => {
    const { tx, row } = fakeTx(CUSTOMER);
    const first = await newWorkspaceBillingData(tx, "user-1", NOW);
    // The workspace is deleted; the user row, and its trialStartedAt, stay.
    const later = await newWorkspaceBillingData(tx, "user-1", new Date(NOW.getTime() + 30 * DAY));
    expect(row?.trialStartedAt).toEqual(NOW);
    expect(later.trialEndsAt).toEqual(first.trialEndsAt);
    expect(planState(later, new Date(NOW.getTime() + 30 * DAY))).toBe("ended");
  });

  it("two creations at once by one person get one window", async () => {
    const { tx, updateMany } = fakeTx(CUSTOMER);
    const [a, b] = await Promise.all([
      newWorkspaceBillingData(tx, "user-1", NOW),
      newWorkspaceBillingData(tx, "user-1", new Date(NOW.getTime() + 1000)),
    ]);
    expect(a.trialEndsAt).toEqual(b.trialEndsAt);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("an operator's workspace is exempt with no trial, and the operator's own window is not started", async () => {
    const { tx, row, updateMany } = fakeTx({ email: "ops@example.com", emailVerifiedAt: new Date("2026-11-01"), trialStartedAt: null });
    const data = await newWorkspaceBillingData(tx, "op-1", NOW);
    expect(data).toEqual({ billingExempt: true });
    expect(updateMany).not.toHaveBeenCalled();
    expect(row?.trialStartedAt).toBeNull();
    expect(planState(data, NOW)).toBe("exempt");
  });

  it("an unverified address on the operator list is a customer", async () => {
    const { tx } = fakeTx({ email: "ops@example.com", emailVerifiedAt: null, trialStartedAt: null });
    expect((await newWorkspaceBillingData(tx, "u", NOW)).billingExempt).toBe(false);
  });

  it("throws for a user that does not exist, so the creating transaction rolls back", async () => {
    const { tx } = fakeTx(null);
    await expect(newWorkspaceBillingData(tx, "ghost", NOW)).rejects.toThrow(/ghost/);
  });
});
