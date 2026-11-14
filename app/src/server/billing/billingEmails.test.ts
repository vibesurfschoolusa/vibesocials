import { describe, expect, it, vi } from "vitest";

import { buildPaymentFailedEmail, buildTrialEndedEmail, buildTrialEndingEmail } from "./billingEmails";

describe("billing emails", () => {
  it("payment failed names the workspace, escaped, and says what happens next", () => {
    const email = buildPaymentFailedEmail({ workspaceId: "ws_1", workspaceName: "Surf <Co>" });
    expect(email.subject).toBe("We could not charge your card for Surf <Co>");
    expect(email.html).toContain(
      "We could not charge your card for Surf &lt;Co&gt;. Update it under Settings, Plan. Update your card soon, or posting will stop.",
    );
    expect(email.html).not.toContain("<Co>");
  });

  // R2-pages L4: the end is a moment; without the recipient's zone it is labelled UTC.
  it("trial ending gives the date and time, labelled UTC without a zone", () => {
    const email = buildTrialEndingEmail({ workspaceId: "ws_1", workspaceName: "Surf Co", trialEndsAt: new Date("2026-11-13T09:00:00Z") });
    expect(email.html).toContain("Your free trial ends on Fri, Nov 13, 2026, 9:00 AM UTC. Choose a plan under Settings, Plan.");
    expect(email.subject).toContain("Surf Co");
  });

  it("trial ending gives the time in the recipient's zone when it is known", () => {
    const email = buildTrialEndingEmail({
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      trialEndsAt: new Date("2026-11-13T03:00:00Z"),
      timeZone: "America/New_York",
    });
    expect(email.html).toContain("Your free trial ends on Thu, Nov 12, 2026, 10:00 PM EST.");
  });

  // S1 follow-up: what the publish job really does with a due post (PLAN_ENDED, retryable).
  it("trial ended says posting stopped and what happens to scheduled posts", () => {
    const email = buildTrialEndedEmail({ workspaceId: "ws_1", workspaceName: "Surf Co" });
    expect(email.html).toContain(
      "Your free trial has ended, so posting has stopped. A scheduled post that comes due without a plan is marked failed. Once you choose a plan you can retry it from Activity, as long as its photos and videos are still kept: those of finished posts are removed 30 days after they were last added to a post.",
    );
    expect(email.html).not.toContain("on hold");
    expect(email.html).not.toMatch(/nothing/i);
    // Files of finished posts go after 30 days, so no promise that posts "stay".
    expect(email.html).not.toMatch(/stay/i);
    expect(email.subject).toContain("Surf Co");
  });

  // S1 fix round 2: the 7 days run from the period end and the email can come
  // late, so the email names no number of days.
  it("payment failed names no number of days, and keeps the link", () => {
    const email = buildPaymentFailedEmail({ workspaceId: "ws_1", workspaceName: "Surf Co" }, "https://app.example.test");
    expect(email.html).not.toMatch(/\d+ days?/);
    expect(email.html).toContain('<a href="https://app.example.test/go?w=ws_1&amp;to=%2Fsettings%23plan">Open Settings, Plan</a>');
  });

  it("the two reminder emails keep their words", () => {
    expect(
      buildTrialEndingEmail({ workspaceId: "ws_1", workspaceName: "Surf Co", trialEndsAt: new Date("2026-11-13T09:00:00Z") }, null).html,
    ).toBe(
      "<p><strong>Surf Co</strong></p>\n<p>Your free trial ends on Fri, Nov 13, 2026, 9:00 AM UTC. Choose a plan under Settings, Plan.</p>\n<p>— Vibe Socials</p>",
    );
    expect(buildPaymentFailedEmail({ workspaceId: "ws_1", workspaceName: "Surf Co" }, null).html).toBe(
      "<p>We could not charge your card for Surf Co. Update it under Settings, Plan. Update your card soon, or posting will stop.</p>\n<p>— Vibe Socials</p>",
    );
  });
});

describe("billing emails link to Settings, Plan (S1 item 6)", () => {
  const BASE = "https://app.example.test/";

  // F4: through /go, so an owner of several workspaces lands on this workspace's Plan.
  it.each([
    ["payment failed", () => buildPaymentFailedEmail({ workspaceId: "ws_7", workspaceName: "Surf Co" }, BASE)],
    [
      "trial ending",
      () =>
        buildTrialEndingEmail(
          { workspaceId: "ws_7", workspaceName: "Surf Co", trialEndsAt: new Date("2026-11-13T09:00:00Z") },
          BASE,
        ),
    ],
    ["trial ended", () => buildTrialEndedEmail({ workspaceId: "ws_7", workspaceName: "Surf Co" }, BASE)],
  ])("%s links to this workspace's Settings, Plan through /go", (_name, build) => {
    const { html } = build();
    expect(html).toContain('<a href="https://app.example.test/go?w=ws_7&amp;to=%2Fsettings%23plan">Open Settings, Plan</a>');
    expect(html).not.toContain('href="https://app.example.test/settings');
  });

  it("reads the address from NEXTAUTH_URL when not given", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://vibe.example.test");
    try {
      expect(buildTrialEndedEmail({ workspaceId: "ws_1", workspaceName: "Surf Co" }).html).toContain(
        'href="https://vibe.example.test/go?w=ws_1&amp;to=%2Fsettings%23plan"',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("without an address, has no link and keeps the words", () => {
    const email = buildPaymentFailedEmail({ workspaceId: "ws_1", workspaceName: "Surf Co" }, null);
    expect(email.html).not.toContain("<a ");
    expect(email.html).toContain("Update it under Settings, Plan.");
  });
});
