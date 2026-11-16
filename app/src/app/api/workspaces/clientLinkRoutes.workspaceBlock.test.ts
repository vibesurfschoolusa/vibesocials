import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { TRIAL_ENDED_MESSAGE } from "@/lib/workspaceStatus";

/**
 * R21 client-journey L1: the three owner GETs report a blocked workspace (a
 * pause, or with billing on an ended trial or plan) the way the public link
 * pages refuse it, so the panels stop offering Copy and Replace.
 */

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  requireOwnerContext: vi.fn(),
  isWorkspaceOwner: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const delegate = { findFirst: h.findFirst };
  return {
    prisma: { workspaceUploadLink: delegate, workspaceReviewLink: delegate, workspaceConnectLink: delegate },
  };
});
vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: h.requireOwnerContext,
  isWorkspaceOwner: h.isWorkspaceOwner,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { sealSecret } from "@/lib/tokenCrypto";

import * as connectRoute from "./connect-link/route";
import * as reviewRoute from "./review-link/route";
import * as uploadRoute from "./upload-link/route";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const RAW = "R".repeat(43);

const ROUTES = [
  ["upload", uploadRoute, "http://localhost/api/workspaces/upload-link"],
  ["review", reviewRoute, "http://localhost/api/workspaces/review-link"],
  ["connect", connectRoute, "http://localhost/api/workspaces/connect-link"],
] as const;

function ownerContext(status: Record<string, unknown>) {
  return { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co", ...status }, role: "owner" as const };
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
  h.isWorkspaceOwner.mockResolvedValue(true);
  h.findFirst.mockResolvedValue({
    id: "link-1",
    workspaceId: "ws-1",
    tokenSealed: sealSecret(RAW),
    createdById: "user-1",
    createdAt: new Date("2026-11-10T10:00:00Z"),
    revokedAt: null,
    lastUsedAt: null,
    uploadCount: 3,
    platforms: ["youtube"],
    expiresAt: new Date(NOW.getTime() + DAY),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const get = async (route: (typeof ROUTES)[number][1], url: string) =>
  (await route.GET(new Request(`${url}?workspaceId=ws-1`))).json();

describe.each(ROUTES)("the %s link's owner GET", (_name, route, url) => {
  it("a paused workspace: says the links don't work, and still returns the link so it can be turned off", async () => {
    h.requireOwnerContext.mockResolvedValue(ownerContext({ pausedAt: NOW, pausedReason: null }));
    const body = await get(route, url);
    expect(body.workspaceBlocked).toBe(
      `Client links don't work right now. This workspace is paused. Contact ${SUPPORT_EMAIL}.`,
    );
    expect(body.link).not.toBeNull();
  });

  it("billing on with an ended trial: blocked like paused", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    h.requireOwnerContext.mockResolvedValue(ownerContext({ trialEndsAt: new Date(NOW.getTime() - DAY) }));
    const body = await get(route, url);
    // GG2 review: the panel says what brings the links back, not "to keep posting".
    expect(body.workspaceBlocked).toBe(
      `Client links don't work right now. Your free trial has ended. Choose Growth or Pro in Settings and your client links work again, or contact ${SUPPORT_EMAIL}.`,
    );
    expect(body.workspaceBlocked).not.toContain(TRIAL_ENDED_MESSAGE);
  });

  it("an active workspace: no block key, as today", async () => {
    h.requireOwnerContext.mockResolvedValue(ownerContext({ pausedAt: null }));
    const body = await get(route, url);
    expect(body).not.toHaveProperty("workspaceBlocked");
    expect(body).not.toHaveProperty("pausedByPlan");
  });
});
