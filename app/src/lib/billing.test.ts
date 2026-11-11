import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BILLING_FIELDS_SELECT,
  billingEnabled,
  billingFieldsSelect,
  planState,
  trialDays,
  type BillingFields,
} from "./billing";

const ON = { BILLING_ENABLED: "true" };
const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("billingEnabled", () => {
  it("is true exactly when BILLING_ENABLED is \"true\"", () => {
    expect(billingEnabled(ON)).toBe(true);
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "false"]) {
      expect(billingEnabled({ BILLING_ENABLED: value }), String(value)).toBe(false);
    }
  });

  it("needs no other variable", () => {
    expect(billingEnabled({ BILLING_ENABLED: "true", BILLING_STARTED_AT: "nonsense" })).toBe(true);
  });

  it("reads process.env at call time by default", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    expect(billingEnabled()).toBe(true);
    vi.stubEnv("BILLING_ENABLED", "");
    expect(billingEnabled()).toBe(false);
  });
});

/**
 * Fix round 1: a workspace can be "ended" only if it was offered a trial or
 * had a plan. A row with neither (created with billing off) is exempt.
 */
describe("planState", () => {
  const none: BillingFields = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };

  it("exempt: billingExempt wins over everything", () => {
    expect(planState({ ...none, billingExempt: true }, NOW)).toBe("exempt");
    expect(planState({ ...none, billingExempt: true, plan: "pro", planStatus: "canceled" }, NOW)).toBe("exempt");
    expect(planState({ ...none, billingExempt: true, trialEndsAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe("exempt");
  });

  it("exempt: no plan and no trial date, whatever billingExempt says", () => {
    expect(planState(none, NOW)).toBe("exempt");
    expect(planState({}, NOW)).toBe("exempt");
    expect(planState({ billingExempt: false, plan: null, trialEndsAt: undefined }, NOW)).toBe("exempt");
  });

  it("exempt: an unparseable trial date with no plan counts as no trial date", () => {
    expect(planState({ ...none, trialEndsAt: "not a date" }, NOW)).toBe("exempt");
    expect(planState({ ...none, trialEndsAt: new Date(Number.NaN) }, NOW)).toBe("exempt");
  });

  it("active: a plan that is active or trialing", () => {
    expect(planState({ ...none, plan: "growth", planStatus: "active" }, NOW)).toBe("active");
    expect(planState({ ...none, plan: "growth", planStatus: "trialing" }, NOW)).toBe("active");
  });

  it("active: past_due until 7 days after the period end; ended at 7 days exactly", () => {
    const end = new Date("2026-12-05T00:00:00Z");
    const pastDue = { ...none, plan: "starter", planStatus: "past_due", currentPeriodEnd: end };
    expect(planState(pastDue, new Date(end.getTime() + 7 * DAY - 1))).toBe("active");
    expect(planState(pastDue, new Date(end.getTime() + 7 * DAY))).toBe("ended");
    expect(planState({ ...pastDue, currentPeriodEnd: null }, NOW)).toBe("ended");
    expect(planState({ ...pastDue, currentPeriodEnd: "garbage" }, NOW)).toBe("ended");
  });

  it("ended: a plan cancelled, unpaid, with an unknown or a missing status", () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired", "something_new", null, undefined]) {
      expect(planState({ ...none, plan: "pro", planStatus: status }, NOW), String(status)).toBe("ended");
    }
  });

  it("trial: no plan, trial date in the future; ended from that very second", () => {
    expect(planState({ ...none, trialEndsAt: new Date(NOW.getTime() + 1000) }, NOW)).toBe("trial");
    expect(planState({ ...none, trialEndsAt: NOW }, NOW)).toBe("ended");
    expect(planState({ ...none, trialEndsAt: new Date(NOW.getTime() - 1000) }, NOW)).toBe("ended");
  });

  it("a plan set over a trial date is judged by the plan", () => {
    expect(planState({ ...none, plan: "pro", planStatus: "active", trialEndsAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe(
      "active",
    );
    expect(planState({ ...none, plan: "pro", planStatus: "canceled", trialEndsAt: new Date(NOW.getTime() + DAY) }, NOW)).toBe(
      "ended",
    );
  });

  it("the memoized form (dates as strings) gives the same state as the fresh row, for every case", () => {
    const end = new Date("2026-12-05T00:00:00Z");
    const rows: BillingFields[] = [
      none,
      { ...none, billingExempt: true },
      { ...none, trialEndsAt: new Date(NOW.getTime() + 3 * DAY) },
      { ...none, trialEndsAt: new Date(NOW.getTime() - DAY) },
      { ...none, billingExempt: true, trialEndsAt: new Date(NOW.getTime() - DAY) },
      { ...none, plan: "growth", planStatus: "active", currentPeriodEnd: end },
      { ...none, plan: "growth", planStatus: "past_due", currentPeriodEnd: end },
      { ...none, plan: "growth", planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 8 * DAY) },
      { ...none, plan: "growth", planStatus: "canceled", currentPeriodEnd: end },
    ];
    for (const row of rows) {
      const memoized = JSON.parse(JSON.stringify(row)) as BillingFields;
      expect(planState(memoized, NOW), JSON.stringify(row)).toBe(planState(row, NOW));
    }
  });
});

describe("trialDays", () => {
  it("defaults to 14 and stays within 1 to 90", () => {
    expect(trialDays({})).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "30" })).toBe(30);
    expect(trialDays({ BILLING_TRIAL_DAYS: "0" })).toBe(1);
    expect(trialDays({ BILLING_TRIAL_DAYS: "1" })).toBe(1);
    expect(trialDays({ BILLING_TRIAL_DAYS: "90" })).toBe(90);
    expect(trialDays({ BILLING_TRIAL_DAYS: "91" })).toBe(90);
    expect(trialDays({ BILLING_TRIAL_DAYS: "-5" })).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "7.5" })).toBe(14);
    expect(trialDays({ BILLING_TRIAL_DAYS: "two weeks" })).toBe(14);
  });
});

describe("billingFieldsSelect", () => {
  it("adds nothing to a query with billing off, and the plan columns with it on", () => {
    expect(billingFieldsSelect({})).toEqual({});
    expect(billingFieldsSelect(ON)).toEqual(BILLING_FIELDS_SELECT);
    expect(BILLING_FIELDS_SELECT).toEqual({
      billingExempt: true,
      plan: true,
      planStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
    });
  });
});
