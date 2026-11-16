import { afterEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { TRIAL_ENDED_MESSAGE, workspaceBlock } from "@/lib/workspaceStatus";

import { clientLinkPanelStatus } from "./clientLinkPanelStatus";

/**
 * R21 client-journey L1: what the owner link panels are told follows the rule
 * findActiveReviewLink/UploadLink/ConnectLink apply (workspaceBlock), so a
 * link a client would see as "not active" is never offered to copy.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => vi.unstubAllEnvs());

describe("clientLinkPanelStatus", () => {
  it("a paused workspace: blocked, with the pause sentence", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const status = clientLinkPanelStatus({ pausedAt: NOW, pausedReason: null }, NOW);
    expect(status.workspaceBlocked).toBe(
      `Client links don't work right now. This workspace is paused. Contact ${SUPPORT_EMAIL}.`,
    );
    expect(status).not.toHaveProperty("pausedByPlan");
  });

  it("billing on with an ended trial: blocked like paused", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const status = clientLinkPanelStatus({ trialEndsAt: new Date(NOW.getTime() - DAY) }, NOW);
    // GG2 review: the shared sentence said "to keep posting", which is off on a link panel.
    expect(status.workspaceBlocked).toBe(
      `Client links don't work right now. Your free trial has ended. Choose Growth or Pro in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`,
    );
    expect(status.workspaceBlocked).not.toContain(TRIAL_ENDED_MESSAGE);
  });

  // R23 pages L1: Starter has no client links, so "any plan" was a false promise.
  it("billing on with an ended Growth plan: names the plans with client links", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const status = clientLinkPanelStatus({ plan: "growth", planStatus: "canceled", currentPeriodEnd: new Date(NOW.getTime() - DAY) }, NOW);
    expect(status.workspaceBlocked).toBe(
      `Client links don't work right now. Your plan has ended. Choose Growth or Pro in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`,
    );
  });

  it("billing on with an ended Starter plan: says Starter has none, and never that renewing it brings them back", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const status = clientLinkPanelStatus({ plan: "starter", planStatus: "canceled", currentPeriodEnd: new Date(NOW.getTime() - DAY) }, NOW);
    expect(status.workspaceBlocked).toBe(
      `Client links don't work right now. Your Starter plan has ended, and Starter doesn't include client links. Choose Growth or Pro in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`,
    );
  });

  it("a plan without client links: only the plan flag, as today", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const status = clientLinkPanelStatus(
      { plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) },
      NOW,
    );
    expect(status).toEqual({ pausedByPlan: true });
  });

  it("an active workspace: nothing, as today", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect(clientLinkPanelStatus({ pausedAt: null }, NOW)).toEqual({});
  });

  it("blocked exactly when workspaceBlock says so", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const cases = [
      { pausedAt: NOW },
      { trialEndsAt: new Date(NOW.getTime() - DAY) },
      { trialEndsAt: new Date(NOW.getTime() + DAY) },
      { plan: "growth", planStatus: "canceled" },
      { plan: "growth", planStatus: "active" },
      { billingExempt: true },
    ];
    for (const workspace of cases) {
      expect(Boolean(clientLinkPanelStatus(workspace, NOW).workspaceBlocked)).toBe(
        Boolean(workspaceBlock(workspace, NOW)),
      );
    }
  });
});
