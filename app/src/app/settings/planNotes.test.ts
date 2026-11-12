import { describe, expect, it } from "vitest";

import { settingsPlanNotes } from "./planNotes";

const NOW = new Date("2026-12-10T12:00:00Z");
const LATER = new Date("2026-12-30T00:00:00Z");
const ON = { BILLING_ENABLED: "true" };

describe("settingsPlanNotes (P1)", () => {
  it("names what Starter leaves out", () => {
    expect(settingsPlanNotes({ plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, ON, NOW)).toEqual({
      // Fix round 2: in place of the brand voice section's own sentence.
      brandVoice:
        "On the Growth and Pro plans, the AI follows this when it writes or rewrites a caption and when it drafts a reply to a Google review.",
      reviewAlerts:
        "New-review emails are sent on the Growth and Pro plans. Your choice here is kept for when you choose one.",
      // P1 fix round 2.
      monthlyReport: "The monthly report email is part of the Growth and Pro plans.",
      logo: "Your logo shows on the monthly report on the Growth and Pro plans.",
    });
  });

  it("is empty on Growth, in a trial, for an exempt workspace and with billing off", () => {
    for (const [workspace, env] of [
      [{ plan: "growth", planStatus: "active", currentPeriodEnd: LATER }, ON],
      [{ trialEndsAt: LATER }, ON],
      [{ billingExempt: true }, ON],
      [{}, ON],
      [{ plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, {}],
    ] as const) {
      expect(settingsPlanNotes(workspace, env, NOW)).toEqual({});
    }
  });
});
