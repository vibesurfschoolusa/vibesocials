import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
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
vi.mock("@/components/plan-actions", () => ({ PlanActions: () => null }));

import { PlanSection } from "@/components/plan-section";
import { planPersonalPostNote } from "@/components/planSectionView";

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
  planPaidAt: new Date("2026-12-02T01:00:00Z"),
};

function membership(billing: Record<string, unknown> = BILLING) {
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
      ...billing,
    },
  };
}

function tx() {
  return {
    workspace: { create: h.workspaceCreate },
    workspaceMember: { create: h.memberCreate },
    user: { findUnique: h.userFindUnique, updateMany: h.userUpdateMany },
  };
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.getCurrentUser.mockResolvedValue({ id: "user-1", email: "a@example.com", name: "Ann" });
  h.findMany.mockResolvedValue([membership()]);
  h.workspaceCreate.mockResolvedValue({ id: "ws-new" });
  h.memberCreate.mockResolvedValue({});
  h.userFindUnique.mockResolvedValue({ email: "a@example.com", emailVerifiedAt: null, trialStartedAt: null });
  h.userUpdateMany.mockResolvedValue({ count: 1 });
  vi.stubEnv("BILLING_ENABLED", "");
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
}

describe("getWorkspaceContext", () => {
  it("with billing off, carries no billing field", async () => {
    const context = await getWorkspaceContext();
    for (const key of Object.keys(BILLING)) {
      expect(context?.workspace, key).not.toHaveProperty(key);
    }
  });

  it("with billing on, carries the plan columns from the row it already reads", async () => {
    billingOn();
    const context = await getWorkspaceContext();
    expect(context?.workspace).toMatchObject(BILLING);
    expect(context?.workspace).not.toHaveProperty("createdAt");
    expect(h.findMany).toHaveBeenCalledTimes(1);
  });

  // R10-security M1 follow-up: Settings, Plan reads paysForPlan from this
  // context (planPersonalPostNote), so it must carry planPaidAt.
  describe("Settings, Plan from the context, as the page builds it", () => {
    const VIEWER = { emailVerifiedAt: new Date("2026-11-01T09:00:00Z"), createdAt: new Date("2026-11-01T08:00:00Z") };
    const USAGE = {
      postsToday: { used: 0, limit: 50, resetsAt: null },
      xPostsThisMonth: { used: 0, limit: 100, resetsAt: null },
      youtubeUploadsToday: { used: 0, limit: 5, resetsAt: null },
      storage: { used: 0, limit: 1024 ** 3, resetsAt: null },
    };
    async function planHtml() {
      const context = await getWorkspaceContext();
      const note = planPersonalPostNote(context!.workspace, VIEWER, false, NOW);
      return renderToStaticMarkup(
        createElement(PlanSection, { workspaceId: "ws-1", label: "Growth plan", usage: USAGE, personalPostNote: note }),
      );
    }

    it("a paid workspace: no per-person note and no line until the first payment", async () => {
      billingOn();
      const html = await planHtml();
      expect(html).toMatch(/<dd>50<\/dd>/);
      expect(html).not.toContain("not yet paid for");
      expect(html).not.toContain("Until the first payment");
    });

    it("the same plan with no paid invoice yet: the note and the line", async () => {
      billingOn();
      h.findMany.mockResolvedValue([membership({ ...BILLING, planPaidAt: null })]);
      const html = await planHtml();
      expect(html).toContain("not yet paid for");
      expect(html).toContain("Until the first payment, posts here count toward your 15 a day.");
    });
  });
});

describe("provisionPersonalWorkspace", () => {
  it("with billing off, creates the workspace exactly as before", async () => {
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate).toHaveBeenCalledWith({ data: { name: "Ann's workspace" } });
    expect(h.userFindUnique).not.toHaveBeenCalled();
    expect(h.userUpdateMany).not.toHaveBeenCalled();
  });

  it("with billing on, starts the user's free trial of BILLING_TRIAL_DAYS", async () => {
    billingOn();
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate).toHaveBeenCalledWith({
      data: { name: "Ann's workspace", trialEndsAt: new Date(NOW.getTime() + 14 * DAY), billingExempt: false },
    });

    expect(h.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", trialStartedAt: null },
      data: { trialStartedAt: NOW },
    });

    h.workspaceCreate.mockClear();
    vi.stubEnv("BILLING_TRIAL_DAYS", "200");
    await provisionPersonalWorkspace(tx(), { id: "user-1", name: "Ann", email: "a@example.com" });
    expect(h.workspaceCreate.mock.calls[0][0].data.trialEndsAt).toEqual(new Date(NOW.getTime() + 90 * DAY));
  });
});
