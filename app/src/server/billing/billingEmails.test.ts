import { describe, expect, it } from "vitest";

import { buildPaymentFailedEmail, buildTrialEndedEmail, buildTrialEndingEmail } from "./billingEmails";

describe("billing emails", () => {
  it("payment failed names the workspace, escaped, and says what happens next", () => {
    const email = buildPaymentFailedEmail({ workspaceName: "Surf <Co>" });
    expect(email.subject).toBe("We could not charge your card for Surf <Co>");
    expect(email.html).toContain(
      "We could not charge your card for Surf &lt;Co&gt;. Update it under Settings, Plan. Your posts keep going out for 7 days.",
    );
    expect(email.html).not.toContain("<Co>");
  });

  it("trial ending gives the date", () => {
    const email = buildTrialEndingEmail({ workspaceName: "Surf Co", trialEndsAt: new Date("2026-11-13T09:00:00Z") });
    expect(email.html).toContain("Your free trial ends on 13 November 2026. Choose a plan under Settings, Plan.");
    expect(email.subject).toContain("Surf Co");
  });

  it("trial ended says posts are on hold", () => {
    const email = buildTrialEndedEmail({ workspaceName: "Surf Co" });
    expect(email.html).toContain(
      "Your free trial has ended. Your scheduled posts are on hold until you choose a plan.",
    );
    expect(email.subject).toContain("Surf Co");
  });
});
