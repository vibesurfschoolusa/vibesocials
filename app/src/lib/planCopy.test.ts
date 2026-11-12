import { describe, expect, it } from "vitest";

import { workspacePlanNoteShown, WORKSPACE_PLAN_SENTENCE } from "./planCopy";

/** S1 item 3: true to lib/billing.ts and newWorkspaceTrial.ts (one trial window per person, a plan per workspace). */
describe("WORKSPACE_PLAN_SENTENCE", () => {
  it("says a plan covers one workspace and a second one needs its own after the trial", () => {
    expect(WORKSPACE_PLAN_SENTENCE).toBe(
      "Each plan covers one workspace: one business with its own connected accounts. A second workspace needs its own plan once your trial ends.",
    );
  });
});

/** S1 fix round 1: only where it is true of the screen: a workspace that is not exempt, billing on. */
describe("workspacePlanNoteShown", () => {
  const NOW = new Date("2026-12-10T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const ON = { BILLING_ENABLED: "true" };

  it("shows for a trial, an active plan and an ended one", () => {
    expect(workspacePlanNoteShown({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + DAY) }, NOW, ON)).toBe(true);
    expect(workspacePlanNoteShown({ billingExempt: false, plan: "starter", planStatus: "active" }, NOW, ON)).toBe(true);
    expect(workspacePlanNoteShown({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() - DAY) }, NOW, ON)).toBe(true);
  });

  it("does not show for an exempt workspace, by its flag or by having neither trial nor plan", () => {
    expect(workspacePlanNoteShown({ billingExempt: true, trialEndsAt: new Date(NOW.getTime() + DAY) }, NOW, ON)).toBe(false);
    expect(workspacePlanNoteShown({}, NOW, ON)).toBe(false);
  });

  it("does not show with billing off", () => {
    expect(workspacePlanNoteShown({ billingExempt: false, trialEndsAt: new Date(NOW.getTime() + DAY) }, NOW, {})).toBe(false);
  });
});
