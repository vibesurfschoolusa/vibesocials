import { describe, expect, it } from "vitest";

import { planSectionLabel } from "./planSectionView";

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
    expect(planSectionLabel("owner", { ...growth, planStatus: "trialing" }, NOW, ON)).toBe("Growth plan, renews 3 January");
    expect(planSectionLabel("owner", { ...growth, currentPeriodEnd: null }, NOW, ON)).toBe("Growth plan");
    expect(planSectionLabel("owner", { ...growth, plan: "custom" }, NOW, ON)).toBe("Your plan, renews 3 January");
  });

  it("a plan whose payment failed, still in its week", () => {
    const pastDue = { ...NEW, plan: "pro", planStatus: "past_due", currentPeriodEnd: new Date("2026-12-08T00:00:00Z") };
    expect(planSectionLabel("owner", pastDue, NOW, ON)).toBe(
      "Pro plan. The last payment did not go through; posting stops on 15 December.",
    );
  });

  it("exempt, by its flag or by never having had a trial or a plan", () => {
    expect(planSectionLabel("owner", { ...NEW, billingExempt: true }, NOW, ON)).toBe("Exempt: billed by invoice");
    expect(planSectionLabel("owner", NEW, NOW, ON)).toBe("Exempt: billed by invoice");
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
