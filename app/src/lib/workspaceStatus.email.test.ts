import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_EMAIL } from "./siteInfo";
import {
  accessBlock,
  accessBlockResponse,
  EMAIL_UNCONFIRMED_CODE,
  PLAN_ENDED_CODE,
  WORKSPACE_PAUSED_CODE,
} from "./workspaceStatus";

/**
 * 23: with billing on and email sending configured, a person who has not
 * confirmed their email address may look around a workspace on its free trial
 * but not create or move work. The workspace's own block is checked first and
 * reads as before. Fix round 1: only on a trial (a paid plan charged a card, and
 * an existing customer who pays was never asked to confirm), and never when
 * the app cannot send the link.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const UNCONFIRMED = { email: "new@example.com", emailVerifiedAt: null, googleLinkedAt: null };
const CONFIRMED = { ...UNCONFIRMED, emailVerifiedAt: new Date("2026-12-01T00:00:00Z") };
const GOOGLE = { ...UNCONFIRMED, googleLinkedAt: new Date("2026-12-01T00:00:00Z") };

const EXEMPT_OLD = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null };
const EXEMPT_FLAG = { ...EXEMPT_OLD, billingExempt: true, trialEndsAt: new Date(NOW.getTime() + DAY) };
const TRIAL = { ...EXEMPT_OLD, trialEndsAt: new Date(NOW.getTime() + 5 * DAY) };
const ACTIVE = { ...EXEMPT_OLD, plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) };
const ENDED_TRIAL = { ...EXEMPT_OLD, trialEndsAt: new Date(NOW.getTime() - DAY) };
const PAUSED = { pausedAt: new Date("2026-12-09T00:00:00Z"), pausedReason: "Unpaid invoice." };

const SENTENCE = "Confirm your email address to start posting. We sent a link to new@example.com.";

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("accessBlock with billing on", () => {
  it("allows everyone in an exempt workspace, by its flag or because it predates billing", () => {
    expect(accessBlock({ user: UNCONFIRMED, workspace: EXEMPT_OLD }, NOW)).toBeNull();
    expect(accessBlock({ user: UNCONFIRMED, workspace: EXEMPT_FLAG }, NOW)).toBeNull();
  });

  it("allows an unconfirmed address in a workspace on an active plan", () => {
    expect(accessBlock({ user: UNCONFIRMED, workspace: ACTIVE }, NOW)).toBeNull();
    const pastDue = { ...ACTIVE, planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - DAY) };
    expect(accessBlock({ user: UNCONFIRMED, workspace: pastDue }, NOW)).toBeNull();
  });

  it("allows an unconfirmed address on a trial when the app cannot send email", () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    expect(accessBlock({ user: UNCONFIRMED, workspace: TRIAL }, NOW)).toBeNull();
    vi.stubEnv("RESEND_API_KEY", "");
    expect(accessBlock({ user: UNCONFIRMED, workspace: TRIAL }, NOW)).toBeNull();
  });

  it("allows a confirmed address and a Google sign-in in a trial or paid workspace", () => {
    for (const workspace of [TRIAL, ACTIVE]) {
      expect(accessBlock({ user: CONFIRMED, workspace }, NOW)).toBeNull();
      expect(accessBlock({ user: GOOGLE, workspace }, NOW)).toBeNull();
    }
  });

  it("refuses an unconfirmed address on a trial, naming the address", () => {
    expect(accessBlock({ user: UNCONFIRMED, workspace: TRIAL }, NOW)).toEqual({ code: EMAIL_UNCONFIRMED_CODE, message: SENTENCE });
  });

  it("lets the workspace's block win and read as before", () => {
    const endedPlan = { ...ACTIVE, planStatus: "canceled", currentPeriodEnd: new Date(NOW.getTime() - DAY) };
    expect(accessBlock({ user: UNCONFIRMED, workspace: endedPlan }, NOW)?.code).toBe(PLAN_ENDED_CODE);
    expect(accessBlock({ user: UNCONFIRMED, workspace: ENDED_TRIAL }, NOW)).toEqual({
      code: PLAN_ENDED_CODE,
      message: `Your free trial has ended. Choose a plan in Settings to keep posting, or contact ${SUPPORT_EMAIL}.`,
    });
    expect(accessBlock({ user: UNCONFIRMED, workspace: { ...TRIAL, ...PAUSED } }, NOW)).toEqual({
      code: WORKSPACE_PAUSED_CODE,
      message: `This workspace is paused: Unpaid invoice. Contact ${SUPPORT_EMAIL}.`,
    });
  });
});

describe("accessBlock with billing off", () => {
  it("never refuses for the address, and keeps the pause", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    for (const workspace of [EXEMPT_OLD, TRIAL, ACTIVE, ENDED_TRIAL]) {
      expect(accessBlock({ user: UNCONFIRMED, workspace }, NOW)).toBeNull();
    }
    expect(accessBlock({ user: UNCONFIRMED, workspace: PAUSED }, NOW)?.code).toBe(WORKSPACE_PAUSED_CODE);
  });
});

describe("accessBlockResponse", () => {
  it("is the 403 with the code and sentence", async () => {
    const response = accessBlockResponse({ user: UNCONFIRMED, workspace: TRIAL }, NOW);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: SENTENCE, code: EMAIL_UNCONFIRMED_CODE });
  });

  it("is null when nothing blocks", () => {
    expect(accessBlockResponse({ user: CONFIRMED, workspace: TRIAL }, NOW)).toBeNull();
  });
});
