import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";

const { getWorkspaceContextMock } = vi.hoisted(() => ({ getWorkspaceContextMock: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));

import { GET } from "./route";

/** 21a: the banner's answer with billing on. Billing off: route.test.ts pins today's. */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const CONFIRMED = { emailVerifiedAt: new Date("2026-12-01T00:00:00Z"), googleLinkedAt: null };

function context(
  role: "owner" | "member",
  billing: Record<string, unknown>,
  person: { emailVerifiedAt: Date | null; googleLinkedAt: Date | null } = CONFIRMED,
) {
  const base = makeWorkspaceContext({ role, email: "new@example.com" });
  return {
    ...base,
    user: { ...base.user, ...person },
    workspace: {
      ...base.workspace,
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      ...billing,
    },
  };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/workspaces/status with billing on", () => {
  it("gives the block's sentence for a workspace whose trial ended, to every member, and owners the plan link", async () => {
    const blockedMessage = `Your free trial has ended. Choose a plan in Settings to keep posting, or contact ${SUPPORT_EMAIL}.`;
    getWorkspaceContextMock.mockResolvedValue(context("owner", { trialEndsAt: new Date(NOW.getTime() - DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage, planLink: true });
    getWorkspaceContextMock.mockResolvedValue(context("member", { trialEndsAt: new Date(NOW.getTime() - DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage });
  });

  it("gives owners the quieter line in the last 3 days of a trial", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("owner", { trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }));
    expect(await (await GET()).json()).toEqual({
      blockedMessage: null,
      trialNotice: "Your free trial ends on 12 December. Choose a plan in Settings.",
    });
  });

  it("gives members nothing, and owners earlier in the trial the days left (S1 item 7)", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("member", { trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
    getWorkspaceContextMock.mockResolvedValue(context("member", { trialEndsAt: new Date(NOW.getTime() + 10 * DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
    getWorkspaceContextMock.mockResolvedValue(context("owner", { trialEndsAt: new Date(NOW.getTime() + 10 * DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null, trialDaysLeft: "Free trial: 10 days left." });
  });

  it("gives an unconfirmed address the sentence, and says the link can be sent again", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      context("owner", { trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }, { emailVerifiedAt: null, googleLinkedAt: null }),
    );
    expect(await (await GET()).json()).toEqual({
      blockedMessage: "Confirm your email address to start posting. We sent a link to new@example.com.",
      emailUnconfirmed: true,
    });
  });

  it("says nothing about the address when the app cannot send email, or on a paid plan", async () => {
    const unconfirmed = { emailVerifiedAt: null, googleLinkedAt: null };
    vi.stubEnv("RESEND_API_KEY", undefined);
    getWorkspaceContextMock.mockResolvedValue(context("member", { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) }, unconfirmed));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
    vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
    getWorkspaceContextMock.mockResolvedValue(
      context("member", { plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) }, unconfirmed),
    );
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
  });

  it("gives the workspace's block, not the address, when both apply", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      context("member", { trialEndsAt: new Date(NOW.getTime() - DAY) }, { emailVerifiedAt: null, googleLinkedAt: null }),
    );
    expect(await (await GET()).json()).toEqual({
      blockedMessage: `Your free trial has ended. Choose a plan in Settings to keep posting, or contact ${SUPPORT_EMAIL}.`,
    });
  });

  it("says nothing about the address in an exempt workspace", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("owner", {}, { emailVerifiedAt: null, googleLinkedAt: null }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
  });
});
