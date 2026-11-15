import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linkFind: vi.fn(),
  connectionFind: vi.fn(),
  connectionFindMany: vi.fn(),
  isOwner: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceConnectLink: { findUnique: h.linkFind },
    socialConnection: { findUnique: h.connectionFind, findMany: h.connectionFindMany },
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner }));

import { generateInviteToken, hashInviteToken } from "@/lib/inviteToken";

import { findActiveConnectLink, linkOffers, listLinkConnections, placeTaken } from "./link";

const NOW = new Date("2026-11-11T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    createdById: "owner-1",
    platforms: ["instagram", "tiktok"],
    expiresAt: new Date(NOW.getTime() + DAY),
    revokedAt: null,
    workspace: { name: "Surf Co", pausedAt: null, pausedReason: null, ...workspace },
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.isOwner.mockResolvedValue(true);
  vi.stubEnv("TIKTOK_CLIENT_KEY", "k");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "s");
  vi.stubEnv("TIKTOK_REDIRECT_URI", "r");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("findActiveConnectLink (rule 2)", () => {
  it("finds the link by the token's hash and answers what a flow needs", async () => {
    const { raw } = generateInviteToken();
    h.linkFind.mockResolvedValue(row());

    const link = await findActiveConnectLink(raw);

    expect(h.linkFind.mock.calls[0][0].where).toEqual({ tokenHash: hashInviteToken(raw) });
    expect(link).toEqual({
      id: "link-1",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      createdById: "owner-1",
      platforms: ["instagram", "tiktok"],
      expiresAt: new Date(NOW.getTime() + DAY),
    });
    expect(h.isOwner).toHaveBeenCalledWith("owner-1", "ws-1");
  });

  it("a token of the wrong shape is not looked up", async () => {
    expect(await findActiveConnectLink("short")).toBeNull();
    expect(h.linkFind).not.toHaveBeenCalled();
  });

  it("unknown, revoked, expired, creator no longer owner, and paused all answer null", async () => {
    const token = generateInviteToken().raw;
    for (const [name, value, owner] of [
      ["unknown", null, true],
      ["revoked", row({ revokedAt: new Date(NOW.getTime() - 1000) }), true],
      ["expired", row({ expiresAt: NOW }), true],
      ["not owner", row(), false],
      ["paused", row({}, { pausedAt: new Date(NOW.getTime() - DAY) }), true],
    ] as const) {
      h.linkFind.mockResolvedValue(value);
      h.isOwner.mockResolvedValue(owner);
      expect(await findActiveConnectLink(token), name).toBeNull();
    }
  });

  it("is not active for a workspace whose trial ended, with billing on", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    h.linkFind.mockResolvedValue(
      row({}, { billingExempt: false, plan: null, planStatus: null, trialEndsAt: new Date(NOW.getTime() - DAY), currentPeriodEnd: null }),
    );
    expect(await findActiveConnectLink(generateInviteToken().raw)).toBeNull();
    expect(h.linkFind.mock.calls[0][0].select.workspace.select).toMatchObject({ trialEndsAt: true });
  });
});

describe("linkOffers", () => {
  it("offers a platform the link lists and the site has configured", () => {
    const link = { platforms: ["instagram", "tiktok"] as const };
    expect(linkOffers({ platforms: [...link.platforms] }, "tiktok")).toBe(true);
    // Listed, but its app credentials are not set here.
    expect(linkOffers({ platforms: [...link.platforms] }, "instagram")).toBe(false);
    expect(linkOffers({ platforms: [...link.platforms] }, "x")).toBe(false);
  });
});

describe("placeTaken (rule 3)", () => {
  const working = { platform: "tiktok", expiresAt: new Date(NOW.getTime() + DAY), refreshToken: "sealed", needsReconnect: false };

  it("is free with no connection, or one that needs reconnecting; taken by a working one", async () => {
    h.connectionFind.mockResolvedValueOnce(null);
    expect(await placeTaken("ws-1", "tiktok")).toBe(false);
    h.connectionFind.mockResolvedValueOnce({ ...working, needsReconnect: true });
    expect(await placeTaken("ws-1", "tiktok")).toBe(false);
    h.connectionFind.mockResolvedValueOnce(working);
    expect(await placeTaken("ws-1", "tiktok")).toBe(true);
    expect(h.connectionFind).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "tiktok" } },
      select: { platform: true, expiresAt: true, refreshToken: true, needsReconnect: true },
    });
  });

  // R6 M1: inside the warning window the link may replace it in place.
  it("is free for a connection that can't be renewed and ends within the warning lead", async () => {
    const linkedIn = { platform: "linkedin", refreshToken: null, needsReconnect: false };
    h.connectionFind.mockResolvedValueOnce({ ...linkedIn, expiresAt: new Date(NOW.getTime() + 3 * DAY) });
    expect(await placeTaken("ws-1", "linkedin")).toBe(false);
    h.connectionFind.mockResolvedValueOnce({ ...linkedIn, expiresAt: new Date(NOW.getTime() + 40 * DAY) });
    expect(await placeTaken("ws-1", "linkedin")).toBe(true);
  });
});

describe("listLinkConnections", () => {
  it("says which connection is in its warning window, and never passes a token on", async () => {
    h.connectionFindMany.mockResolvedValue([
      { platform: "linkedin", accountIdentifier: "li", metadata: { username: "Surf Co page" }, needsReconnect: false, expiresAt: new Date(NOW.getTime() + 3 * DAY), refreshToken: null },
      { platform: "tiktok", accountIdentifier: "tt", metadata: { username: "surfco" }, needsReconnect: false, expiresAt: new Date(NOW.getTime() + 3 * DAY), refreshToken: "sealed" },
    ]);

    const connections = await listLinkConnections("ws-1");

    expect(h.connectionFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { accountIdentifier: true, metadata: true, platform: true, expiresAt: true, refreshToken: true, needsReconnect: true },
    });
    expect(connections).toEqual([
      { platform: "linkedin", accountIdentifier: "li", username: "Surf Co page", locationName: null, needsReconnect: false, reconnectSoon: true, ended: false },
      { platform: "tiktok", accountIdentifier: "tt", username: "surfco", locationName: null, needsReconnect: false, reconnectSoon: false, ended: false },
    ]);
    expect(JSON.stringify(connections)).not.toContain("sealed");
  });
});

describe("listLinkConnections: an end date that has passed", () => {
  it("is marked ended, so the page says it stopped working", async () => {
    h.connectionFindMany.mockResolvedValue([
      { platform: "linkedin", accountIdentifier: "li", metadata: {}, needsReconnect: false, expiresAt: new Date(NOW.getTime() - DAY), refreshToken: null },
    ]);
    const [connection] = await listLinkConnections("ws-1");
    expect(connection).toMatchObject({ reconnectSoon: true, ended: true });
  });
});
