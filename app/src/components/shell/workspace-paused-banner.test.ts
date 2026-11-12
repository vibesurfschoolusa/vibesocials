import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "loading" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { readWorkspaceStatus, WorkspaceStatusAlert } from "./workspace-paused-banner";

/** 23: the banner's line for an unconfirmed address, with its resend button, and only for it. */

const SENTENCE = "Confirm your email address to start posting. We sent a link to new@example.com.";

function render(data: unknown): string {
  return renderToStaticMarkup(
    createElement(WorkspaceStatusAlert, { status: readWorkspaceStatus(data), sending: false, onResend: () => {} }),
  );
}

describe("readWorkspaceStatus", () => {
  it("reads the three fields, and takes emailUnconfirmed only with a message", () => {
    expect(readWorkspaceStatus({ blockedMessage: SENTENCE, emailUnconfirmed: true })).toEqual({
      message: SENTENCE,
      notice: null,
      emailUnconfirmed: true,
      daysLeft: null,
      planLink: false,
    });
    expect(readWorkspaceStatus({ blockedMessage: null, emailUnconfirmed: true }).emailUnconfirmed).toBe(false);
    expect(readWorkspaceStatus({ blockedMessage: "Paused.", emailUnconfirmed: "yes" }).emailUnconfirmed).toBe(false);
    expect(readWorkspaceStatus(null)).toEqual({ message: null, notice: null, emailUnconfirmed: false, daysLeft: null, planLink: false });
  });
});

describe("WorkspaceStatusAlert", () => {
  it("shows the sentence and a button to send the link again for an unconfirmed address", () => {
    const html = render({ blockedMessage: SENTENCE, emailUnconfirmed: true });
    expect(html).toContain(SENTENCE);
    expect(html).toMatch(/<button[^>]*>.*Send the link again.*<\/button>/);
  });

  it("shows a pause or an ended plan without the button", () => {
    const html = render({ blockedMessage: "This workspace is paused. Contact us." });
    expect(html).toContain("This workspace is paused. Contact us.");
    expect(html).not.toContain("<button");
  });

  it("shows the trial notice without the button, and nothing when there is nothing to say", () => {
    const html = render({ blockedMessage: null, trialNotice: "Your free trial ends on 12 December." });
    expect(html).toContain("Your free trial ends on 12 December.");
    expect(html).not.toContain("<button");
    expect(render({ blockedMessage: null })).toBe("");
  });
});

describe("WorkspaceStatusAlert links to Settings, Plan (S1 item 7)", () => {
  const PLAN_LINK = /<a [^>]*href="\/settings#plan"[^>]*>Choose a plan<\/a>/;

  it("shows owners a quiet line with the days left and the link for the whole trial", () => {
    const html = render({ blockedMessage: null, trialDaysLeft: "Free trial: 10 days left." });
    expect(html).toContain("Free trial: 10 days left.");
    expect(html).toMatch(PLAN_LINK);
    expect(html).not.toContain('role="alert"');
  });

  it("keeps the louder line in the last 3 days, now with the link", () => {
    const html = render({ blockedMessage: null, trialNotice: "Your free trial ends on 12 December. Choose a plan in Settings." });
    expect(html).toContain("Your free trial ends on 12 December. Choose a plan in Settings.");
    expect(html).toMatch(PLAN_LINK);
  });

  it("links the plan-ended banner for owners only", () => {
    expect(render({ blockedMessage: "Your free trial has ended.", planLink: true })).toMatch(PLAN_LINK);
    expect(render({ blockedMessage: "Your free trial has ended." })).not.toContain("<a ");
  });
});
