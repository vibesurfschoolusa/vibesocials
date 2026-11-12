import { describe, expect, it } from "vitest";

import type { BillingFields } from "./billing";
import {
  PLAN_FEATURE_CODE,
  PLAN_FEATURE_MESSAGES,
  PLAN_FEATURES,
  planFeatureResponse,
  planIncludes,
  type PlanFeature,
} from "./planFeatures";

const NOW = new Date("2026-11-12T12:00:00Z");
const LATER = "2026-12-01T00:00:00Z";
const EARLIER = "2026-11-01T00:00:00Z";
const ON = { BILLING_ENABLED: "true" };
const OFF = {};

const WORKSPACES: Record<string, BillingFields> = {
  exemptByFlag: { billingExempt: true, plan: "starter", planStatus: "active" },
  // Created with billing off: no plan, no trial.
  exemptByAge: {},
  trial: { trialEndsAt: LATER },
  starter: { plan: "starter", planStatus: "active", currentPeriodEnd: LATER },
  growth: { plan: "growth", planStatus: "active", currentPeriodEnd: LATER },
  pro: { plan: "pro", planStatus: "trialing", currentPeriodEnd: LATER },
  growthPastDueInGrace: { plan: "growth", planStatus: "past_due", currentPeriodEnd: "2026-11-10T00:00:00Z" },
  trialEnded: { trialEndsAt: EARLIER },
  planEnded: { plan: "growth", planStatus: "canceled", currentPeriodEnd: EARLIER },
  unknownPlan: { plan: "enterprise", planStatus: "active", currentPeriodEnd: LATER },
};

describe("planIncludes", () => {
  it("knows the five features", () => {
    expect(PLAN_FEATURES).toEqual(["clientLinks", "bulk", "brandVoice", "monthlyReportEmail", "reviewAlerts"]);
  });

  // The table: which workspace gets which feature, with billing on and off.
  const table: Array<[keyof typeof WORKSPACES, boolean, boolean]> = [
    // workspace, billing off, billing on
    ["exemptByFlag", true, true],
    ["exemptByAge", true, true],
    ["trial", true, true],
    ["starter", true, false],
    ["growth", true, true],
    ["pro", true, true],
    ["growthPastDueInGrace", true, true],
    ["trialEnded", true, false],
    ["planEnded", true, false],
    ["unknownPlan", true, false],
  ];

  for (const [name, off, on] of table) {
    for (const feature of PLAN_FEATURES) {
      it(`${name}, ${feature}: ${off ? "included" : "not"} with billing off, ${on ? "included" : "not"} with it on`, () => {
        expect(planIncludes(WORKSPACES[name], feature, OFF, NOW)).toBe(off);
        expect(planIncludes(WORKSPACES[name], feature, ON, NOW)).toBe(on);
      });
    }
  }

  it("with billing off, includes every feature even for a row read without its billing columns", () => {
    for (const feature of PLAN_FEATURES) expect(planIncludes({}, feature, OFF, NOW)).toBe(true);
  });
});

describe("planFeatureResponse", () => {
  it("is null when the plan includes the feature", () => {
    expect(planFeatureResponse(WORKSPACES.growth, "clientLinks", ON, NOW)).toBeNull();
    expect(planFeatureResponse(WORKSPACES.starter, "clientLinks", OFF, NOW)).toBeNull();
    expect(planFeatureResponse(WORKSPACES.exemptByFlag, "clientLinks", ON, NOW)).toBeNull();
  });

  it("is the 403 with the code and the feature's sentence otherwise", async () => {
    const response = planFeatureResponse(WORKSPACES.starter, "clientLinks", ON, NOW);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "Client links are part of the Growth and Pro plans. Choose a plan in Settings, Plan.",
      code: PLAN_FEATURE_CODE,
    });
    expect(PLAN_FEATURE_CODE).toBe("PLAN_FEATURE");
  });

  it("has a sentence for every feature that names the plans and where to choose one", () => {
    for (const feature of PLAN_FEATURES as readonly PlanFeature[]) {
      expect(PLAN_FEATURE_MESSAGES[feature]).toMatch(/part of the Growth and Pro plans\. Choose a plan in Settings, Plan\.$/);
    }
  });
});
