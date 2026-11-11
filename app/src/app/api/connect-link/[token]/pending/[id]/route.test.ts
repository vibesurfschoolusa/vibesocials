import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/connect-link/[token]/pending/[id] (16): the visitor chooses which of
 * several accounts a link flow connects. The link comes from the token (rule
 * 2), the row must be the creator's in the link's workspace AND stamped with
 * this link; POST checks rule 3 again. Answers as the owner's
 * /api/connections/pending/[id] does; never a token.
 */

const h = vi.hoisted(() => ({
  linkFind: vi.fn(),
  linkUpdate: vi.fn(),
  connectionFind: vi.fn(),
  pendingFind: vi.fn(),
  pendingDeleteMany: vi.fn(),
  isOwner: vi.fn(),
  rateLimit: vi.fn(),
  saveFacebookPage: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceConnectLink: { findUnique: h.linkFind, update: h.linkUpdate },
    socialConnection: { findUnique: h.connectionFind },
    pendingConnection: { findUnique: h.pendingFind, deleteMany: h.pendingDeleteMany },
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/connections/saveConnection", () => ({
  saveFacebookPageConnection: h.saveFacebookPage,
  saveInstagramConnection: vi.fn(),
  saveLinkedInConnection: vi.fn(),
  savePinterestConnection: vi.fn(),
  fetchInstagramAccountDetails: vi.fn(),
}));

import { generateInviteToken } from "@/lib/inviteToken";
import { sealSecret } from "@/lib/tokenCrypto";

import { DELETE, GET, POST } from "./route";

const ORIGIN = "https://app.example.com";
const NOW = new Date("2026-11-11T08:00:00Z");
const TOKEN = generateInviteToken().raw;

const PAYLOAD = {
  platform: "facebook_page",
  expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  pages: [
    { id: "page-1", name: "My Surf School", accessToken: "page-token-1" },
    { id: "page-2", name: "Client Cafe", accessToken: "page-token-2" },
  ],
};

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pending-1",
    workspaceId: "ws-1",
    userId: "user-creator",
    platform: "facebook_page",
    payload: sealSecret(JSON.stringify(PAYLOAD)),
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    createdAt: NOW,
    connectLinkId: "link-1",
    ...overrides,
  };
}

function context(id = "pending-1", token = TOKEN) {
  return { params: Promise.resolve({ token, id }) };
}

function request(method: string, body?: unknown): Request {
  return new Request(`${ORIGIN}/api/connect-link/${TOKEN}/pending/pending-1`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  h.linkFind.mockResolvedValue({
    id: "link-1",
    workspaceId: "ws-1",
    createdById: "user-creator",
    platforms: ["facebook_page"],
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    workspace: { name: "Surf Co", pausedAt: null, pausedReason: null },
  });
  h.isOwner.mockResolvedValue(true);
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.pendingFind.mockResolvedValue(pendingRow());
  h.pendingDeleteMany.mockResolvedValue({ count: 1 });
  h.connectionFind.mockResolvedValue(null);
  h.linkUpdate.mockResolvedValue({});
  h.saveFacebookPage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET: the accounts to choose from", () => {
  it("lists names and ids only, never a token", async () => {
    const res = await GET(request("GET"), context());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      platform: "facebook_page",
      candidates: [
        { id: "page-1", name: "My Surf School" },
        { id: "page-2", name: "Client Cafe" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("page-token");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it.each([
    ["an owner's own choice from Settings", pendingRow({ connectLinkId: null })],
    ["another link's choice", pendingRow({ connectLinkId: "link-2" })],
    ["another user's choice", pendingRow({ userId: "user-other" })],
    ["another workspace's choice", pendingRow({ workspaceId: "ws-2" })],
    ["no row", null],
  ])("%s is a 404 with the owner route's sentence", async (_name, row) => {
    h.pendingFind.mockResolvedValue(row);
    const res = await GET(request("GET"), context());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This choice expired. Connect again." });
  });

  it("an inactive link is a 404 that says so", async () => {
    h.linkFind.mockResolvedValue(null);
    const res = await GET(request("GET"), context());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not active/);
    expect(h.pendingFind).not.toHaveBeenCalled();
  });

  it("is rate limited per network", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await GET(request("GET"), context());
    expect(res.status).toBe(429);
  });
});

describe("POST: the visitor's choice", () => {
  it("connects the chosen account as the creator's, deletes the choice, records the use, ends the flow", async () => {
    const res = await POST(request("POST", { candidateId: "page-2" }), context());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, platform: "facebook_page" });
    expect(h.saveFacebookPage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-creator",
      page: { id: "page-2", name: "Client Cafe", accessToken: "page-token-2" },
      expiresAt: new Date(PAYLOAD.expiresAt),
    });
    expect(h.pendingDeleteMany).toHaveBeenCalledWith({ where: { id: "pending-1" } });
    expect(h.linkUpdate).toHaveBeenCalledWith({ where: { id: "link-1" }, data: { lastUsedAt: NOW } });
    expect(res.headers.get("set-cookie")).toMatch(/^vs_connect=;/);
  });

  it("rule 3 again: a working account that arrived meanwhile is never replaced", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: false });

    const res = await POST(request("POST", { candidateId: "page-2" }), context());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Facebook Page is already connected. Ask Surf Co if it should be changed.");
    expect(h.saveFacebookPage).not.toHaveBeenCalled();
  });

  it("a choice that is not one of the accounts is a 400 with the owner route's sentence", async () => {
    const res = await POST(request("POST", { candidateId: "page-9" }), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That account isn't one of the choices." });
  });

  it("no candidateId is a 400 with the owner route's sentence", async () => {
    const res = await POST(request("POST", {}), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "candidateId is required." });
  });

  it("an owner's own choice is a 404, and nothing is saved", async () => {
    h.pendingFind.mockResolvedValue(pendingRow({ connectLinkId: null }));
    const res = await POST(request("POST", { candidateId: "page-2" }), context());
    expect(res.status).toBe(404);
    expect(h.saveFacebookPage).not.toHaveBeenCalled();
  });

  it("a save failure is a 500 that names no token", async () => {
    h.saveFacebookPage.mockRejectedValue(new Error("db down"));
    const res = await POST(request("POST", { candidateId: "page-2" }), context());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to connect the account." });
  });
});

describe("DELETE: Cancel", () => {
  it("drops the choice and ends the flow", async () => {
    const res = await DELETE(request("DELETE"), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.pendingDeleteMany).toHaveBeenCalledWith({ where: { id: "pending-1" } });
    expect(res.headers.get("set-cookie")).toMatch(/^vs_connect=;/);
  });

  it("another link's choice is a 404 and is left alone", async () => {
    h.pendingFind.mockResolvedValue(pendingRow({ connectLinkId: "link-2" }));
    const res = await DELETE(request("DELETE"), context());
    expect(res.status).toBe(404);
    expect(h.pendingDeleteMany).not.toHaveBeenCalled();
  });
});
