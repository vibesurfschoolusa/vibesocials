import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 21a: what getWorkspaceContext carries for billing, and the trial a new
 * personal workspace starts with. Billing off: both exactly as before (the
 * existing workspace.test.ts pins that); billing on: below.
 */

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  workspaceCreate: vi.fn(),
  memberCreate: vi.fn(),
  getCurrentUser: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: h.findMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: h.cookieGet }) }));

import { getWorkspaceContext, provisionPersonalWorkspace } from "./workspace";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const CREATED = new Date("2026-12-02T00:00:00Z");
const BILLING = {
  billingExempt: false,
  plan: "growth",
  planStatus: "active",
  trialEndsAt: null,
  currentPeriodEnd: new Date("2027-01-02T00:00:00Z"),
};

function membership() {
  return {
    workspaceId: "ws-1",
    role: "owner",
    createdAt: CREATED,
    workspace: {
      id: "ws-1",
      name: "Surf Co",
      companyWebsite: null,
      defaultHashtags: null,
      requireApproval: false,
      googleButtonType: null,
      googleButtonUrl: null,
      brandVoice: null,
      brandVoiceExamples: null,
      trackWebsiteLinks: false,
      pausedAt: null,
      pausedReason: null,
      createdAt: CREATED,
      ...BILLING,
    },
  };
}

function tx() {
  return { workspace: { create: h.workspaceCreate }, workspaceMember: { create: h.memberCreate } };
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.getCurrentUser.mockResolvedValue({ id: "user-1", email: "a@example.com", name: "Ann" });
  h.findMany.mockResolvedValue([membership()]);
  h.workspaceCreate.mockResolvedValue({ id: "ws-new" });
  h.memberCreate.mockResolvedValue({});
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("BILLING_STARTED_AT", "");
  vi.stubEnv("BILLING_TRIAL_DAYS", "");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function billingOn() {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_STARTED_AT", "2026-12-01T00:00:00Z");
}

describe("getWorkspaceContext", () => {
  it("with billing off, carries no billing field", async () => {
    const context = await getWorkspaceContext();
    for (const key of ["createdAt", ...Object.keys(BILLING)]) {
      expect(context?.workspace, key).not.toHaveProperty(key);
    }
  });

  it("with billing on, carries the plan columns and the creation date from the row it already reads", async () => {
    billingOn();
    const context = await getWorkspaceContext();
    expect(context?.workspace).toMatchObject({ createdAt: CREATED, ...BILLING });
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("provisionPersonalWorkspace", () => {
  it("with billing off, creates the workspace exactly as before", async () => {
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate).toHaveBeenCalledWith({ data: { name: "Ann's workspace" } });
  });

  it("with billing on, starts a free trial of BILLING_TRIAL_DAYS", async () => {
    billingOn();
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate).toHaveBeenCalledWith({
      data: { name: "Ann's workspace", trialEndsAt: new Date(NOW.getTime() + 14 * DAY), billingExempt: false },
    });

    h.workspaceCreate.mockClear();
    vi.stubEnv("BILLING_TRIAL_DAYS", "200");
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate.mock.calls[0][0].data.trialEndsAt).toEqual(new Date(NOW.getTime() + 90 * DAY));
  });
});
