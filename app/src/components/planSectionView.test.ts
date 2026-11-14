import { describe, expect, it } from "vitest";

import { planGrowthAddsShown, planSectionLabel } from "./planSectionView";

/** 21a: what Settings → Plan says, and when it is there at all. */

const ON = { BILLING_ENABLED: "true" };
const NOW = new Date("2026-12-10T12:00:00Z");
const NEW = {
  billingExempt: false,
  plan: null,
  planStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
};

describe("planSectionLabel", () => {
  it("is absent with billing off, whatever the workspace", () => {
    for (const env of [{}, { BILLING_ENABLED: "TRUE" }, { ...ON, BILLING_ENABLED: "false" }]) {
      expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") }, NOW, env)).toBeNull();
      expect(planSectionLabel("owner", { billingExempt: true }, NOW, env)).toBeNull();
    }
  });

  it("is absent for members", () => {
    expect(planSectionLabel("member", { ...NEW, trialEndsAt: new Date("2026-12-24T00:00:00Z") }, NOW, ON)).toBeNull();
    expect(planSectionLabel("member", { ...NEW, billingExempt: true }, NOW, ON)).toBeNull();
  });

  it("a trial", () => {
    expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-24T09:00:00Z") }, NOW, ON)).toBe(
      "Free trial until 24 December",
    );
  });

  it("an active plan, with and without a renewal date", () => {
    const growth = { ...NEW, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2027-01-03T00:00:00Z") };
    expect(planSectionLabel("owner", growth, NOW, ON)).toBe("Growth plan, renews 3 January");
    expect(planSectionLabel("owner", { ...growth, currentPeriodEnd: null }, NOW, ON)).toBe("Growth plan");
    expect(planSectionLabel("owner", { ...growth, plan: "custom" }, NOW, ON)).toBe("Your plan, renews 3 January");
  });

  // Live billing test 2026-11-13: a plan chosen during the free trial is "trialing"
  // at Stripe until the trial ends, and nothing has been charged yet, so its
  // period end is the first payment, not a renewal.
  it("a plan still in Stripe's trial: the period end is the first payment", () => {
    const trialing = { ...NEW, plan: "starter", planStatus: "trialing", currentPeriodEnd: new Date("2026-12-24T04:00:00Z") };
    expect(planSectionLabel("owner", trialing, NOW, ON)).toBe("Starter plan, first payment on 24 December");
    expect(planSectionLabel("owner", { ...trialing, plan: "custom" }, NOW, ON)).toBe("Your plan, first payment on 24 December");
    // Cancelled during the trial: it ends then and is never charged.
    expect(planSectionLabel("owner", { ...trialing, planEndsAt: new Date("2026-12-24T04:00:00Z") }, NOW, ON)).toBe(
      "Starter plan, ends on 24 December",
    );
    expect(planSectionLabel("owner", { ...trialing, currentPeriodEnd: null }, NOW, ON)).toBe("Starter plan");
    // Once Stripe has charged it, the same plan renews as before.
    expect(planSectionLabel("owner", { ...trialing, planStatus: "active" }, NOW, ON)).toBe("Starter plan, renews 24 December");
  });

  it("a plan whose payment failed, still in its week", () => {
    const pastDue = { ...NEW, plan: "pro", planStatus: "past_due", currentPeriodEnd: new Date("2026-12-08T00:00:00Z") };
    expect(planSectionLabel("owner", pastDue, NOW, ON)).toBe(
      "Pro plan. The last payment did not go through; posting stops on 15 December.",
    );
  });

  it("exempt, by its flag or by never having had a trial or a plan", () => {
    expect(planSectionLabel("owner", { ...NEW, billingExempt: true }, NOW, ON)).toBe("No plan is needed for this workspace.");
    expect(planSectionLabel("owner", NEW, NOW, ON)).toBe("No plan is needed for this workspace.");
  });

  it("ended: a plan, or a trial", () => {
    expect(planSectionLabel("owner", { ...NEW, plan: "starter", planStatus: "canceled" }, NOW, ON)).toBe(
      "Your plan has ended",
    );
    expect(planSectionLabel("owner", { ...NEW, trialEndsAt: new Date("2026-12-09T00:00:00Z") }, NOW, ON)).toBe(
      "Your free trial has ended",
    );
  });
});

// P1: on an active Starter plan, Settings says what Growth adds.
describe("planGrowthAddsShown", () => {
  const ON = { BILLING_ENABLED: "true" };
  const NOW = new Date("2026-12-10T12:00:00Z");
  const LATER = new Date("2026-12-30T00:00:00Z");

  it("is true for an owner on an active Starter plan with billing on", () => {
    expect(planGrowthAddsShown("owner", { plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(true);
  });

  it("is false on Growth, in a trial, exempt, ended, for a member and with billing off", () => {
    const starter = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };
    expect(planGrowthAddsShown("owner", { ...starter, plan: "growth" }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { trialEndsAt: LATER }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { ...starter, billingExempt: true }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", { ...starter, planStatus: "canceled", currentPeriodEnd: NOW }, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("member", starter, NOW, ON)).toBe(false);
    expect(planGrowthAddsShown("owner", starter, NOW, {})).toBe(false);
  });
});

// P1 fix round 2: the line follows planIncludes, not the plan's name.
describe("planGrowthAddsShown asks the rule", () => {
  const ON = { BILLING_ENABLED: "true" };
  const NOW = new Date("2026-12-10T12:00:00Z");
  const LATER = new Date("2026-12-30T00:00:00Z");

  it("shows the line for any active plan without the Growth features, an unknown one too", () => {
    expect(planGrowthAddsShown("owner", { plan: "enterprise", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(true);
  });

  it("not on Pro", () => {
    expect(planGrowthAddsShown("owner", { plan: "pro", planStatus: "active", currentPeriodEnd: LATER }, NOW, ON)).toBe(false);
  });
});
