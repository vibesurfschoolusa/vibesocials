import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock } = vi.hoisted(() => ({ getWorkspaceContextMock: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));

import { GET } from "./route";

/** 21a: the banner's answer with billing on. Billing off: route.test.ts pins today's. */

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function context(role: "owner" | "member", billing: Record<string, unknown>) {
  const base = makeWorkspaceContext({ role });
  return {
    ...base,
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
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/workspaces/status with billing on", () => {
  it("gives the block's sentence for a workspace whose trial ended, to every member", async () => {
    for (const role of ["owner", "member"] as const) {
      getWorkspaceContextMock.mockResolvedValue(context(role, { trialEndsAt: new Date(NOW.getTime() - DAY) }));
      expect(await (await GET()).json()).toEqual({
        blockedMessage: "Your free trial has ended. Choose a plan in Settings to keep posting.",
      });
    }
  });

  it("gives owners the quieter line in the last 3 days of a trial", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("owner", { trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }));
    expect(await (await GET()).json()).toEqual({
      blockedMessage: null,
      trialNotice: "Your free trial ends on 12 December. Choose a plan in Settings.",
    });
  });

  it("gives members, and owners earlier in the trial, nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("member", { trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
    getWorkspaceContextMock.mockResolvedValue(context("owner", { trialEndsAt: new Date(NOW.getTime() + 10 * DAY) }));
    expect(await (await GET()).json()).toEqual({ blockedMessage: null });
  });
});
