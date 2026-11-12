import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: client links are a Growth and Pro feature. A link of a workspace without
 * it answers exactly as an inactive link, on every public page and route,
 * because all of them resolve the token through these three finders. Nothing
 * is written: the link is paused, not revoked, and works again on an upgrade.
 */

const h = vi.hoisted(() => ({
  uploadFind: vi.fn(),
  reviewFind: vi.fn(),
  connectFind: vi.fn(),
  isOwner: vi.fn(),
  writes: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findUnique: h.uploadFind, update: h.writes, updateMany: h.writes, delete: h.writes },
    workspaceReviewLink: { findUnique: h.reviewFind, update: h.writes, updateMany: h.writes, delete: h.writes },
    workspaceConnectLink: { findUnique: h.connectFind, update: h.writes, updateMany: h.writes, delete: h.writes },
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: vi.fn() }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: vi.fn() }));

import { generateInviteToken } from "@/lib/inviteToken";

import { findActiveConnectLink } from "./connectLink/link";
import { findActiveReviewLink } from "./reviewLink";
import { findActiveUploadLink } from "./uploadLink";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    name: "Surf Co",
    pausedAt: null,
    pausedReason: null,
    billingExempt: false,
    plan: null,
    planStatus: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    ...overrides,
  };
}

const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) };
const GROWTH = { ...STARTER, plan: "growth" };
const PRO = { ...STARTER, plan: "pro" };
const TRIAL = { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) };
const EXEMPT_BY_FLAG = { ...STARTER, billingExempt: true };
const EXEMPT_BY_AGE = {};

function row(ws: Record<string, unknown>) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    createdById: "owner-1",
    revokedAt: null,
    platforms: ["youtube"],
    expiresAt: new Date(NOW.getTime() + DAY),
    workspace: ws,
  };
}

const LINKS = [
  ["upload", h.uploadFind, findActiveUploadLink],
  ["review", h.reviewFind, findActiveReviewLink],
  ["connect", h.connectFind, findActiveConnectLink],
] as const;

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.isOwner.mockResolvedValue(true);
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(LINKS)("the %s link, by plan", (_name, find, resolve) => {
  it("answers as an inactive link on Starter", async () => {
    find.mockResolvedValue(row(workspace(STARTER)));
    expect(await resolve(generateInviteToken().raw)).toBeNull();
  });

  it("works on Growth, Pro, a trial, and for an exempt workspace", async () => {
    for (const ws of [GROWTH, PRO, TRIAL, EXEMPT_BY_FLAG, EXEMPT_BY_AGE]) {
      find.mockResolvedValue(row(workspace(ws)));
      expect(await resolve(generateInviteToken().raw)).toMatchObject({ id: "link-1", workspaceName: "Surf Co" });
    }
  });

  it("is paused, not revoked: nothing is written, and the same row works again after choosing Growth", async () => {
    const token = generateInviteToken().raw;
    find.mockResolvedValue(row(workspace(STARTER)));
    expect(await resolve(token)).toBeNull();
    expect(h.writes).not.toHaveBeenCalled();
    find.mockResolvedValue(row(workspace(GROWTH)));
    expect(await resolve(token)).toMatchObject({ id: "link-1" });
  });

  it("with billing off, works whatever the plan columns hold", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    find.mockResolvedValue(row(workspace(STARTER)));
    expect(await resolve(generateInviteToken().raw)).toMatchObject({ id: "link-1" });
  });
});
