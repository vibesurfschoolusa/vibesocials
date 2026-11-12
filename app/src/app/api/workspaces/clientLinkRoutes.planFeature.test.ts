import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: the owner routes of the three client links. Without the plan feature a
 * new link is refused (403, PLAN_FEATURE), the GET answers the link with
 * `pausedByPlan: true`, and turning a link off still works. With the feature,
 * billing off, or an exempt workspace, every answer is exactly today's: no
 * `pausedByPlan` key at all.
 */

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  requireOwnerContext: vi.fn(),
  isWorkspaceOwner: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const delegate = { findFirst: h.findFirst, updateMany: h.updateMany, create: h.create };
  return {
    prisma: {
      workspaceUploadLink: delegate,
      workspaceReviewLink: delegate,
      workspaceConnectLink: delegate,
      $transaction: h.transaction,
    },
  };
});
vi.mock("@/lib/workspace", () => ({
  requireOwnerContext: h.requireOwnerContext,
  isWorkspaceOwner: h.isWorkspaceOwner,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));

import { sealSecret } from "@/lib/tokenCrypto";

import * as connectRoute from "./connect-link/route";
import * as reviewRoute from "./review-link/route";
import * as uploadRoute from "./upload-link/route";

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const RAW = "R".repeat(43);
const SENTENCE = "Client links are part of the Growth and Pro plans. See Settings, Plan.";

const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) };
const GROWTH = { ...STARTER, plan: "growth" };
const TRIAL = { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) };
const EXEMPT_BY_FLAG = { ...STARTER, billingExempt: true };

function ownerContext(billing: Record<string, unknown>) {
  return { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co", ...billing }, role: "owner" as const };
}

function linkRow() {
  return {
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
  };
}

const ROUTES = [
  ["upload", uploadRoute, "http://localhost/api/workspaces/upload-link"],
  ["review", reviewRoute, "http://localhost/api/workspaces/review-link"],
  ["connect", connectRoute, "http://localhost/api/workspaces/connect-link"],
] as const;

const post = (url: string) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws-1", platforms: ["youtube"] }),
  });
const del = (url: string) =>
  new Request(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws-1" }),
  });

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  h.isWorkspaceOwner.mockResolvedValue(true);
  h.findFirst.mockResolvedValue(linkRow());
  h.updateMany.mockResolvedValue({ count: 1 });
  h.create.mockResolvedValue(linkRow());
  h.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: h.executeRaw,
      workspaceUploadLink: { updateMany: h.updateMany, create: h.create },
      workspaceReviewLink: { updateMany: h.updateMany, create: h.create },
      workspaceConnectLink: { updateMany: h.updateMany, create: h.create },
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(ROUTES)("the %s link's owner routes on Starter", (_name, route, url) => {
  beforeEach(() => {
    h.requireOwnerContext.mockResolvedValue(ownerContext(STARTER));
  });

  it("refuse a new link with the code and the sentence, and change nothing", async () => {
    const response = await route.POST(post(url));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SENTENCE, code: "PLAN_FEATURE" });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.checkRateLimit).not.toHaveBeenCalled();
  });

  it("answer the link with the flag that the plan pauses it", async () => {
    const body = await (await route.GET(new Request(`${url}?workspaceId=ws-1`))).json();
    expect(body.pausedByPlan).toBe(true);
    expect(body.link).toMatchObject({ url: expect.stringContaining(RAW) });
  });

  it("still turn a link off", async () => {
    const response = await route.DELETE(del(url));
    expect(response.status).toBe(200);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe.each(ROUTES)("the %s link's owner routes as today", (_name, route, url) => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["Growth", GROWTH, true],
    ["a trial", TRIAL, true],
    ["an exempt workspace", EXEMPT_BY_FLAG, true],
    ["billing off, whatever the columns say", STARTER, false],
  ];
  for (const [label, billing, billingOn] of cases) {
    it(`${label}: the GET has no flag and a new link is not refused by the plan`, async () => {
      if (!billingOn) vi.stubEnv("BILLING_ENABLED", "");
      h.requireOwnerContext.mockResolvedValue(ownerContext(billing));
      const body = await (await route.GET(new Request(`${url}?workspaceId=ws-1`))).json();
      expect(body).not.toHaveProperty("pausedByPlan");
      const created = await route.POST(post(url));
      expect((await created.json()).code).not.toBe("PLAN_FEATURE");
    });
  }
});
