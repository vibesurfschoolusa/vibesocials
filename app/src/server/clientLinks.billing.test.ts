import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 21a: a client's upload and review links answer "not active" for a workspace
 * whose trial or plan ended, as for a paused one. The plan columns come in the
 * same query, only with billing on; with it off the existing tests pin today's.
 */

const h = vi.hoisted(() => ({ uploadFind: vi.fn(), reviewFind: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findUnique: h.uploadFind },
    workspaceReviewLink: { findUnique: h.reviewFind },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: vi.fn() }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: vi.fn() }));

import { generateInviteToken } from "@/lib/inviteToken";

import { findActiveReviewLink } from "./reviewLink";
import { findActiveUploadLink } from "./uploadLink";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const WORKSPACE_SELECT_ON = {
  name: true,
  pausedAt: true,
  pausedReason: true,
  billingExempt: true,
  plan: true,
  planStatus: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
};

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    name: "Surf Co",
    pausedAt: null,
    pausedReason: null,
    billingExempt: false,
    plan: null,
    planStatus: null,
    trialEndsAt: new Date(NOW.getTime() - DAY),
    currentPeriodEnd: null,
    ...overrides,
  };
}

function row(ws: Record<string, unknown>) {
  return { id: "link-1", workspaceId: "ws-1", createdById: "owner-1", revokedAt: null, workspace: ws };
}

const LINKS = [
  ["upload", h.uploadFind, findActiveUploadLink],
  ["review", h.reviewFind, findActiveReviewLink],
] as const;

beforeEach(() => {
  h.uploadFind.mockReset();
  h.reviewFind.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(LINKS)("the %s link with billing on", (_name, find, resolve) => {
  it("is not active for a workspace whose trial ended", async () => {
    find.mockResolvedValue(row(workspace()));
    expect(await resolve(generateInviteToken().raw)).toBeNull();
    expect(find.mock.calls[0][0].select.workspace).toEqual({ select: WORKSPACE_SELECT_ON });
  });

  it("is not active for a workspace whose plan ended", async () => {
    find.mockResolvedValue(row(workspace({ plan: "pro", planStatus: "unpaid" })));
    expect(await resolve(generateInviteToken().raw)).toBeNull();
  });

  it("is active in a trial, on an active plan, and for an exempt workspace", async () => {
    for (const ws of [
      workspace({ trialEndsAt: new Date(NOW.getTime() + DAY) }),
      workspace({ plan: "starter", planStatus: "active" }),
      workspace({ billingExempt: true }),
    ]) {
      find.mockResolvedValue(row(ws));
      expect(await resolve(generateInviteToken().raw)).toMatchObject({ id: "link-1", workspaceName: "Surf Co" });
    }
  });
});

describe.each(LINKS)("the %s link with billing off", (_name, find, resolve) => {
  it("ignores the plan columns", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    find.mockResolvedValue(row(workspace()));
    expect(await resolve(generateInviteToken().raw)).toMatchObject({ id: "link-1" });
    expect(find.mock.calls[0][0].select.workspace).toEqual({
      select: { name: true, pausedAt: true, pausedReason: true },
    });
  });
});
