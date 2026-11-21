import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// R58 pages-a-2 L2: the operator pages said "(1 need reconnecting)".

const h = vi.hoisted(() => ({ getOperator: vi.fn(), checkAdminRateLimit: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator")>()),
  getOperator: h.getOperator,
  checkAdminRateLimit: h.checkAdminRateLimit,
}));
vi.mock("@/server/admin/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/queries")>()),
  listAdminWorkspaces: h.list,
  getAdminWorkspaceDetail: h.detail,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/server/billing/adminStripeLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing/adminStripeLinks")>()),
  stripeLinkFlags: async () => ({ hasCustomer: false, hasSubscription: false }),
}));
// The forms are client components that need the app router; this test reads only the page's text.
vi.mock("./workspaces/[id]/admin-controls", () => ({
  AdminBillingControls: () => null,
  AdminLimitsForm: () => null,
  AdminPauseControls: () => null,
}));

import AdminPage from "./page";
import AdminWorkspacePage from "./workspaces/[id]/page";

const row = (reconnectCount: number) => ({
  id: "ws-1",
  name: "Surf Co",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ownerEmails: ["owner@example.com"],
  memberCount: 1,
  platforms: ["instagram", "x"],
  reconnectCount,
  published30d: 0,
  failed30d: 0,
  storageBytes: 0,
  pausedAt: null,
  planState: "exempt",
});

const detail = (reconnectCount: number) => ({
  workspace: row(reconnectCount),
  pausedReason: null,
  billing: {
    enabled: false,
    state: "exempt",
    billingExempt: true,
    plan: null,
    planStatus: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
  },
  overrides: { limitPostsPerDay: null, limitXPostsPerMonth: null, limitYoutubeUploadsPerDay: null, limitStorageMb: null },
  effectiveLimits: { postsPerDay: 20, xPostsPerMonth: 30, youtubeUploadsPerDay: 10, storageBytes: 1 },
  defaultLimits: { postsPerDay: 20, xPostsPerMonth: 30, youtubeUploadsPerDay: 10, storageBytes: 1 },
  usage: null,
  actions: [],
});

const pages = [
  [
    "the workspace list",
    (count: number) => {
      h.list.mockResolvedValue({ rows: [row(count)], hasNextPage: false });
      return AdminPage({ searchParams: Promise.resolve({}) });
    },
  ],
  [
    "one workspace",
    (count: number) => {
      h.detail.mockResolvedValue(detail(count));
      return AdminWorkspacePage({ params: Promise.resolve({ id: "ws-1" }) });
    },
  ],
] as const;

beforeEach(() => {
  h.getOperator.mockResolvedValue({ userId: "op-1", email: "ops@example.com" });
  h.checkAdminRateLimit.mockResolvedValue({ allowed: true });
  h.list.mockReset();
  h.detail.mockReset();
});

describe("the operator pages count connections to reconnect in words that agree", () => {
  it.each(pages)("%s: 1 needs reconnecting", async (_name, load) => {
    const html = renderToStaticMarkup((await load(1)) as ReactElement);
    expect(html).toContain("(1 needs reconnecting)");
  });

  it.each(pages)("%s: 2 need reconnecting", async (_name, load) => {
    const html = renderToStaticMarkup((await load(2)) as ReactElement);
    expect(html).toContain("(2 need reconnecting)");
  });
});
