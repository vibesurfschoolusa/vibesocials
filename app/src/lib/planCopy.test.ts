import { describe, expect, it } from "vitest";

import { WORKSPACE_PLAN_SENTENCE } from "./planCopy";

/** S1 item 3: true to lib/billing.ts and newWorkspaceTrial.ts (one trial window per person, a plan per workspace). */
describe("WORKSPACE_PLAN_SENTENCE", () => {
  it("says a plan covers one workspace and a second one needs its own after the trial", () => {
    expect(WORKSPACE_PLAN_SENTENCE).toBe(
      "Each plan covers one workspace: one business with its own connected accounts. A second workspace needs its own plan once your trial ends.",
    );
  });
});
