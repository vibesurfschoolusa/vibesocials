import { describe, expect, it } from "vitest";

import type { BillingFields } from "@/lib/billing";

import { adminBillingLines } from "./billingSentence";

/** Fix round 1: the admin page's billing sentences, true for every state. */

const NOW = new Date("2026-11-10T12:00:00Z");
const NONE = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };

function lines(fields: BillingFields, enabled = true) {
  return adminBillingLines({ ...NONE, ...fields, enabled }, NOW);
}

describe("adminBillingLines", () => {
  it("says billing is off in one line, and still describes what the fields give", () => {
    expect(lines({}, false).enforcement).toBe("Billing is off. Nothing is enforced.");
    expect(lines({}, true).enforcement).toBe("Billing is on. This state is enforced.");
  });

  it("exempt by its flag", () => {
    expect(lines({ billingExempt: true, trialEndsAt: new Date("2026-11-01T00:00:00Z") }).state).toBe(
      "Exempt: never blocked for its plan, and on the default limits unless overridden below.",
    );
  });

  it("exempt because it was never offered a trial and has no plan", () => {
    expect(lines({}).state).toBe(
      "Exempt: it was never offered a trial and has no plan (it was created while billing was off), so it is never blocked for its plan.",
    );
  });

  it("in a trial", () => {
    expect(lines({ trialEndsAt: new Date("2026-11-24T23:59:59.999Z") }).state).toBe(
      "In a free trial until 24 November 2026, on the Starter limits unless overridden below. Posting stops then unless a plan is chosen.",
    );
  });

  it("on a plan, paid or in its week after a failed payment", () => {
    expect(lines({ plan: "growth", planStatus: "active" }).state).toBe("On a plan, with that plan's limits.");
    expect(
      lines({ plan: "growth", planStatus: "past_due", currentPeriodEnd: new Date("2026-11-08T00:00:00Z") }).state,
    ).toBe("On a plan whose last payment failed. Posting stops on 15 November 2026 unless it is paid.");
  });

  it("ended, for a trial or a plan", () => {
    const ended =
      "Ended: with billing on it cannot upload, create, schedule or publish, like a paused workspace. Posts that come due are marked failed and can be retried once a plan is active. Nothing is charged or deleted.";
    expect(lines({ trialEndsAt: new Date("2026-11-01T00:00:00Z") }).state).toBe(ended);
    expect(lines({ plan: "pro", planStatus: "canceled" }).state).toBe(ended);
  });
});
