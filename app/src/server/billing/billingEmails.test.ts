import { describe, expect, it, vi } from "vitest";

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

describe("billing emails link to Settings, Plan (S1 item 6)", () => {
  const BASE = "https://app.example.test/";

  it("each email links to /settings#plan on the app's own address", () => {
    const emails = [
      buildPaymentFailedEmail({ workspaceName: "Surf Co" }, BASE),
      buildTrialEndingEmail({ workspaceName: "Surf Co", trialEndsAt: new Date("2026-11-13T09:00:00Z") }, BASE),
      buildTrialEndedEmail({ workspaceName: "Surf Co" }, BASE),
    ];
    for (const email of emails) {
      expect(email.html).toContain('<a href="https://app.example.test/settings#plan">Open Settings, Plan</a>');
    }
  });

  it("reads the address from NEXTAUTH_URL when not given", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://vibe.example.test");
    try {
      expect(buildTrialEndedEmail({ workspaceName: "Surf Co" }).html).toContain(
        'href="https://vibe.example.test/settings#plan"',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("without an address, has no link and keeps the words", () => {
    const email = buildPaymentFailedEmail({ workspaceName: "Surf Co" }, null);
    expect(email.html).not.toContain("<a ");
    expect(email.html).toContain("Update it under Settings, Plan.");
  });
});
