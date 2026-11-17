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
  isOwner: vi.fn(),
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
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext, isWorkspaceOwner: h.isOwner }));
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

/** The Settings group sends the workspace its page was rendered for (F3). */
function body(method: "POST" | "DELETE", value: Record<string, unknown>): Request {
  return new Request(BASE, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws-1", ...value }),
  });
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
  h.isOwner.mockResolvedValue(true);
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

// Fix round 1: a link whose creator is no longer an owner works for no
// visitor (server/connectLink/link.ts), so Settings must not show it either.
describe("a link whose creator is no longer an owner", () => {
  const live = linkRow({ createdById: "user-2" });

  it("creator still an owner: shown, as before", async () => {
    h.findFirst.mockResolvedValue(live);
    const res = await GET(new Request(BASE));
    expect((await res.json()).link.url).toBe(`${ORIGIN}/c/${RAW}`);
    expect(h.isOwner).toHaveBeenCalledWith("user-2", "ws-1");
  });

  it("creator removed or demoted: no link, so the group offers Create link", async () => {
    h.findFirst.mockResolvedValue(live);
    h.isOwner.mockResolvedValue(false);
    const res = await GET(new Request(BASE));
    expect(await res.json()).toEqual({ link: null, available: ["tiktok", "instagram"] });
  });

  it("revoked and expired rows are not even read, as before", async () => {
    await GET(new Request(BASE));
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", revokedAt: null, expiresAt: { gt: NOW } });
    expect(h.isOwner).not.toHaveBeenCalled();
  });

  it("a paused workspace with a live creator: shown, as before (the pause banner tells the owner)", async () => {
    h.requireOwnerContext.mockResolvedValue({
      ...OWNER,
      workspace: { ...OWNER.workspace, pausedAt: NOW, pausedReason: "Unpaid" },
    });
    h.findFirst.mockResolvedValue(live);
    const res = await GET(new Request(BASE));
    expect((await res.json()).link).not.toBeNull();
  });

  it("POST with a dead link in place creates a new one and the old row ends revoked", async () => {
    h.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(body("POST", { platforms: ["tiktok"] }));
    expect(res.status).toBe(200);
    expect(h.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", revokedAt: null }, data: { revokedAt: NOW } });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("DELETE when the only row is a dead one answers as for nothing to revoke", async () => {
    h.updateMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(body("DELETE", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// F3 (2026-11-14 review): POST and DELETE now require the id; a page from
// before it was sent is told to reload.
describe("connect-link POST and DELETE and the rendered workspace", () => {
  it.each(["POST", "DELETE"] as const)("%s 409s another workspace's id, and writes nothing", async (method) => {
    const handler = method === "POST" ? POST : DELETE;
    const res = await handler(body(method, { platforms: ["tiktok"], workspaceId: "ws-2" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKSPACE_CHANGED");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)("%s 400s a body without the id, and writes nothing", async (method) => {
    const handler = method === "POST" ? POST : DELETE;
    const res = await handler(
      new Request(BASE, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platforms: ["tiktok"] }) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MISSING_WORKSPACE_ID");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});

// GG2 review: the server refuses a new link while the workspace is blocked.
describe("POST while the workspace is blocked", () => {
  it("a paused workspace gets a 403 with the panel's sentence and no link is made", async () => {
    h.requireOwnerContext.mockResolvedValue({
      ...OWNER,
      workspace: { ...OWNER.workspace, pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: null },
    });
    const response = await POST(body("POST", { workspaceId: "ws-1" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/^Client links don't work right now\./);
    expect(h.create).not.toHaveBeenCalled();
  });
});

// R44 new-customer L1: the limit is a fixed hour counted across every workspace
// the person owns, so the refusal names the real wait, not "Try again later".
describe("the hourly limit names its wait", () => {
  it("at 40 minutes left: the reason, the wait in minutes, and Retry-After", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 40 * 60 });
    const response = await POST(body("POST", { platforms: ["tiktok"] }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2400");
    await expect(response.json()).resolves.toEqual({
      error: "You've made 10 new connect links this hour, counted across all your workspaces. Too many tries. Wait 40 minutes, then try again.",
      retryAfterSeconds: 2400,
    });
  });
});
