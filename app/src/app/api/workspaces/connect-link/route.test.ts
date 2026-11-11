import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/workspaces/connect-link (16): an owner's client connect link. Shaped
 * like the review link's owner routes: owner only, the workspace from the
 * owner gate, rate limited, one active link (creating revokes the old one).
 */

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  executeRaw: vi.fn(),
  requireOwnerContext: vi.fn(),
  rateLimit: vi.fn(),
  generateInviteToken: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceConnectLink: { findFirst: h.findFirst, updateMany: h.updateMany, create: h.create },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: h.executeRaw,
        workspaceConnectLink: { updateMany: h.updateMany, create: h.create },
      }),
  },
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/inviteToken", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inviteToken")>("@/lib/inviteToken");
  return { ...actual, generateInviteToken: h.generateInviteToken };
});

import { hashInviteToken } from "@/lib/inviteToken";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";

import { DELETE, GET, POST } from "./route";

const ORIGIN = "https://vibesocials.example";
const RAW = "R".repeat(43);
const NOW = new Date("2026-11-11T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const OWNER = { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co" }, role: "owner" as const };
const BASE = "http://localhost/api/workspaces/connect-link";

function body(method: "POST" | "DELETE", value: unknown): Request {
  return new Request(BASE, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    tokenHash: hashInviteToken(RAW),
    tokenSealed: sealSecret(RAW),
    createdById: "user-1",
    platforms: ["tiktok"],
    expiresAt: new Date(NOW.getTime() + 14 * DAY),
    createdAt: NOW,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  for (const [key, value] of Object.entries({
    TIKTOK_CLIENT_KEY: "k",
    TIKTOK_CLIENT_SECRET: "s",
    TIKTOK_REDIRECT_URI: "r",
    FACEBOOK_APP_ID: "k",
    FACEBOOK_APP_SECRET: "s",
    INSTAGRAM_REDIRECT_URI: "r",
  })) {
    vi.stubEnv(key, value);
  }
  h.requireOwnerContext.mockResolvedValue(OWNER);
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.generateInviteToken.mockReturnValue({ raw: RAW, hash: hashInviteToken(RAW) });
  h.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => linkRow(data));
  h.updateMany.mockResolvedValue({ count: 0 });
  h.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("owner only, as the review link's routes", () => {
  it.each([
    ["signed out", NextResponse.json({ error: "Unauthorized" }, { status: 401 }), 401],
    ["a member", NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 }), 403],
  ])("%s gets the owner gate's answer from GET, POST and DELETE, and nothing is read or written", async (_n, gate, status) => {
    h.requireOwnerContext.mockResolvedValue(gate);
    for (const res of [
      await GET(new Request(BASE)),
      await POST(body("POST", { platforms: ["tiktok"] })),
      await DELETE(body("DELETE", {})),
    ]) {
      expect(res.status).toBe(status);
    }
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("answers no link, and the platforms this site can offer", async () => {
    const res = await GET(new Request(BASE));
    expect(await res.json()).toEqual({ link: null, available: ["tiktok", "instagram"] });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null, expiresAt: { gt: NOW } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("answers the current link's address, platforms, expiry and last use", async () => {
    h.findFirst.mockResolvedValue(linkRow({ lastUsedAt: new Date(NOW.getTime() - DAY) }));
    const res = await GET(new Request(BASE));
    expect((await res.json()).link).toEqual({
      url: `${ORIGIN}/c/${RAW}`,
      platforms: ["tiktok"],
      expiresAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
      lastUsedAt: new Date(NOW.getTime() - DAY).toISOString(),
      createdAt: NOW.toISOString(),
    });
  });

  it("a workspace id that is not the active one is a 409", async () => {
    const res = await GET(new Request(`${BASE}?workspaceId=ws-2`));
    expect(res.status).toBe(409);
  });
});

describe("POST: create", () => {
  it("revokes the old link and makes one that offers the ticked platforms for 14 days, under a lock", async () => {
    const res = await POST(body("POST", { platforms: ["instagram", "tiktok"], workspaceId: "ws-1" }));

    expect(res.status).toBe(200);
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", revokedAt: null }, data: { revokedAt: NOW } });
    const data = h.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      workspaceId: "ws-1",
      tokenHash: hashInviteToken(RAW),
      createdById: "user-1",
      platforms: ["tiktok", "instagram"],
      expiresAt: new Date(NOW.getTime() + 14 * DAY),
    });
    expect(openSecret(data.tokenSealed as string)).toBe(RAW);
    expect(h.updateMany.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]);
    expect((await res.json()).link.url).toBe(`${ORIGIN}/c/${RAW}`);
  });

  it.each([
    ["no platforms", { platforms: [] }],
    ["no list", {}],
    ["an unknown platform", { platforms: ["myspace"] }],
    ["a platform not configured here", { platforms: ["x"] }],
  ])("%s is a 400 and nothing is written", async (_n, value) => {
    const res = await POST(body("POST", value));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("is rate limited per owner", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(body("POST", { platforms: ["tiktok"] }));
    expect(res.status).toBe(429);
    expect(h.rateLimit.mock.calls[0][0]).toMatchObject({ userId: "user-1", route: "workspaces/connect-link" });
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("DELETE: revoke", () => {
  it("revokes the active link and answers ok", async () => {
    const res = await DELETE(body("DELETE", { workspaceId: "ws-1" }));
    expect(await res.json()).toEqual({ ok: true });
    expect(h.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", revokedAt: null }, data: { revokedAt: NOW } });
  });
});
