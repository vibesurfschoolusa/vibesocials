import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Platform } from "@prisma/client";

/**
 * Client connect link (16), through the real callbacks: a visitor's flow
 * (link state or X handshake row, plus the sealed cookie) is saved exactly as
 * the creator's own connect would save it, without a session, and they land on
 * their own page. An ordinary owner's X handshake never finishes as a link
 * flow and a link's handshake never finishes as an ordinary one.
 */

const h = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isOwner: vi.fn(),
  upsert: vi.fn(),
  connectionFind: vi.fn(),
  pendingCreate: vi.fn(),
  pendingDeleteMany: vi.fn(),
  pendingUpdateMany: vi.fn(),
  linkFind: vi.fn(),
  linkUpdate: vi.fn(),
  handshakeFind: vi.fn(),
  handshakeDelete: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { upsert: h.upsert, findUnique: h.connectionFind },
    pendingConnection: { create: h.pendingCreate, deleteMany: h.pendingDeleteMany, updateMany: h.pendingUpdateMany },
    workspaceConnectLink: { findUnique: h.linkFind, update: h.linkUpdate },
    oAuthHandshake: { findUnique: h.handshakeFind, delete: h.handshakeDelete },
    $transaction: (operations: Array<Promise<unknown>>) => Promise.all(operations),
  },
}));

import { generateInviteToken } from "@/lib/inviteToken";
import { createConnectLinkState } from "@/lib/oauthState";
import { sealConnectCookie } from "@/server/connectLink/cookie";

import { GET as facebookPageGET } from "./facebook_page/callback/route";
import { GET as gbpGET } from "./google_business_profile/callback/route";
import { GET as instagramGET } from "./instagram/callback/route";
import { GET as linkedinGET } from "./linkedin/callback/route";
import { GET as pinterestGET } from "./pinterest/callback/route";
import { GET as tiktokGET } from "./tiktok/callback/route";
import { GET as xGET } from "./x/callback/route";
import { GET as youtubeGET } from "./youtube/callback/route";

const ORIGIN = "https://app.example.com";
const NOW = new Date("2026-11-11T08:00:00.000Z");
const TOKEN = generateInviteToken().raw;
const CREATOR = "user-creator";
const WORKSPACE = "ws-1";
const ALL: Platform[] = ["tiktok", "youtube", "google_business_profile", "instagram", "facebook_page", "linkedin", "pinterest", "x"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function provider(url: string, pages = 1): Response {
  if (url.includes("/me/accounts")) {
    return json({
      data: Array.from({ length: pages }, (_, i) => ({
        id: `page-${i + 1}`,
        name: `Page ${i + 1}`,
        access_token: `page-token-${i + 1}`,
        instagram_business_account: { id: `ig-${i + 1}` },
      })),
    });
  }
  if (url.includes("/ig-1")) return json({ username: "brand" });
  if (url.includes("youtube/v3/channels")) return json({ items: [{ id: "chan-1", snippet: { title: "Channel" } }] });
  if (url.includes("tiktokapis.com/v2/user/info")) return json({ data: { user: { display_name: "Brand" } } });
  if (url.includes("tiktokapis.com")) return json({ access_token: "tt", open_id: "open-1", scope: "video.publish", token_type: "Bearer" });
  if (url.includes("oauth/v2/accessToken")) return json({ access_token: "li", expires_in: 3600, scope: "w_organization_social" });
  if (url.includes("/rest/organizationAcls")) {
    return json({ elements: [{ role: "ADMINISTRATOR", organization: "urn:li:organization:101", state: "APPROVED" }] });
  }
  if (url.includes("/rest/organizations/101")) return json({ id: 101, localizedName: "Org" });
  if (url.includes("/v5/oauth/token")) {
    return json({ access_token: "pin", refresh_token: "pin-r", expires_in: 2592000, scope: "boards:read", token_type: "bearer" });
  }
  if (url.includes("/v5/user_account")) return json({ id: "9001", username: "brand", account_type: "BUSINESS" });
  if (url.includes("/v5/boards")) return json({ items: [{ id: "555", name: "Board" }], bookmark: null });
  if (url.includes("api.twitter.com/oauth/access_token")) {
    return new Response("oauth_token=a&oauth_token_secret=b&screen_name=brand&user_id=42");
  }
  return json({ access_token: "generic", expires_in: 3600, token_type: "Bearer" });
}

type Handler = (request: NextRequest) => Promise<Response>;
const CALLBACKS: Record<Platform, Handler> = {
  tiktok: tiktokGET,
  youtube: youtubeGET,
  google_business_profile: gbpGET,
  instagram: instagramGET,
  facebook_page: facebookPageGET,
  linkedin: linkedinGET,
  pinterest: pinterestGET,
  x: xGET as Handler,
};

function cookie(linkId = "link-1", nonce = "nonce-1"): string {
  return `vs_connect=${encodeURIComponent(sealConnectCookie({ linkId, nonce, token: TOKEN }))}`;
}

function linkRequest(platform: Platform, withCookie = true): NextRequest {
  const url = new URL(`/api/auth/${platform}/callback`, ORIGIN);
  if (platform === "x") {
    url.searchParams.set("oauth_token", "req-token");
    url.searchParams.set("oauth_verifier", "v");
  } else {
    url.searchParams.set("code", "auth-code");
    url.searchParams.set(
      "state",
      createConnectLinkState({ linkId: "link-1", nonce: "nonce-1", userId: CREATOR, workspaceId: WORKSPACE }),
    );
  }
  return new NextRequest(url, withCookie ? { headers: { cookie: cookie() } } : undefined);
}

function handshake(overrides: Record<string, unknown> = {}) {
  return {
    token: "req-token",
    tokenSecret: "secret",
    userId: CREATOR,
    workspaceId: WORKSPACE,
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    createdAt: NOW,
    connectLinkId: "link-1",
    connectLinkNonce: "nonce-1",
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const [key, value] of Object.entries({
    NEXTAUTH_SECRET: "test-secret",
    NEXTAUTH_URL: ORIGIN,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    TIKTOK_CLIENT_KEY: "k",
    TIKTOK_CLIENT_SECRET: "s",
    TIKTOK_REDIRECT_URI: `${ORIGIN}/cb`,
    GOOGLE_GBP_CLIENT_ID: "k",
    GOOGLE_GBP_CLIENT_SECRET: "s",
    GOOGLE_GBP_REDIRECT_URI: `${ORIGIN}/cb`,
    YOUTUBE_REDIRECT_URI: `${ORIGIN}/cb`,
    FACEBOOK_APP_ID: "k",
    FACEBOOK_APP_SECRET: "s",
    INSTAGRAM_REDIRECT_URI: `${ORIGIN}/cb`,
    FACEBOOK_PAGE_REDIRECT_URI: `${ORIGIN}/cb`,
    LINKEDIN_CLIENT_ID: "k",
    LINKEDIN_CLIENT_SECRET: "s",
    LINKEDIN_REDIRECT_URI: `${ORIGIN}/cb`,
    PINTEREST_APP_ID: "1",
    PINTEREST_APP_SECRET: "s",
    PINTEREST_REDIRECT_URI: `${ORIGIN}/cb`,
    X_CONSUMER_KEY: "k",
    X_CONSUMER_SECRET: "s",
    X_CALLBACK_URL: `${ORIGIN}/cb`,
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubGlobal("fetch", h.fetch);
  h.fetch.mockImplementation(async (input: string | URL) => provider(String(input)));
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});

  h.linkFind.mockResolvedValue({
    id: "link-1",
    workspaceId: WORKSPACE,
    createdById: CREATOR,
    platforms: ALL,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    workspace: { name: "Surf Co", pausedAt: null, pausedReason: null },
  });
  h.isOwner.mockResolvedValue(true);
  h.connectionFind.mockResolvedValue(null);
  h.upsert.mockResolvedValue({ id: "conn-1" });
  h.linkUpdate.mockResolvedValue({});
  h.pendingCreate.mockResolvedValue({ id: "pending-1" });
  h.pendingDeleteMany.mockResolvedValue({ count: 0 });
  h.pendingUpdateMany.mockResolvedValue({ count: 1 });
  h.handshakeFind.mockResolvedValue(handshake());
  h.handshakeDelete.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(ALL)("%s: a visitor's flow through the real callback", (platform) => {
  it("is saved as the creator's connect in the link's workspace, with no session, and lands on the visitor's page", async () => {
    const res = await CALLBACKS[platform](linkRequest(platform));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c/${TOKEN}?success=${platform}_connected`);
    expect(h.getCurrentUser).not.toHaveBeenCalled();
    expect(h.isOwner).toHaveBeenCalledWith(CREATOR, WORKSPACE);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const args = h.upsert.mock.calls[0][0] as {
      where: { workspaceId_platform: { workspaceId: string; platform: string } };
      create: { userId: string; workspaceId: string };
    };
    expect(args.where.workspaceId_platform).toEqual({ workspaceId: WORKSPACE, platform });
    expect(args.create.userId).toBe(CREATOR);
    expect(h.linkUpdate).toHaveBeenCalledWith({ where: { id: "link-1" }, data: { lastUsedAt: NOW } });
    expect(res.headers.get("set-cookie")).toMatch(/^vs_connect=;/);
  });

  it("with the place already taken by a working account, nothing is exchanged or written", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: false });

    const res = await CALLBACKS[platform](linkRequest(platform));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c/${TOKEN}?error=${platform}_already_connected`);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("a link flow without its cookie, in a browser signed in as the creator", () => {
  it.each(ALL.filter((p) => p !== "x"))("%s: refused, never the signed-in path", async (platform) => {
    h.getCurrentUser.mockResolvedValue({ id: CREATOR });

    const res = await CALLBACKS[platform](linkRequest(platform, false));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c`);
    expect(h.getCurrentUser).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("x: the link's handshake row is refused by the callback as an expired session", async () => {
    h.getCurrentUser.mockResolvedValue({ id: CREATOR });

    const res = await xGET(linkRequest("x", false));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/settings?error=x_session_expired`);
    expect(h.getCurrentUser).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("a choice at the end of a link flow", () => {
  it("facebook_page with several Pages: the pending row is the creator's, stamped with the link, and the visitor chooses on their page", async () => {
    h.fetch.mockImplementation(async (input: string | URL) => provider(String(input), 2));

    const res = await facebookPageGET(linkRequest("facebook_page"));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c/${TOKEN}?choose=pending-1`);
    expect(h.pendingCreate.mock.calls[0][0].data).toMatchObject({ workspaceId: WORKSPACE, userId: CREATOR });
    expect(h.pendingUpdateMany).toHaveBeenCalledWith({
      where: { id: "pending-1", workspaceId: WORKSPACE, userId: CREATOR },
      data: { connectLinkId: "link-1" },
    });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

// Fix round 1: what the platform itself said decides the visitor's sentence,
// not the code a callback picks for a provider error.
describe("the platform's own refusal in a link flow", () => {
  function refusal(platform: Platform, params: Record<string, string>): NextRequest {
    const request = linkRequest(platform);
    const url = new URL(request.url);
    url.searchParams.delete("code");
    url.searchParams.delete("oauth_verifier");
    if (platform === "x") url.searchParams.delete("oauth_token");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return new NextRequest(url, { headers: { cookie: cookie() } });
  }

  it.each<[string, Platform, Record<string, string>, "cancelled" | "connect_failed"]>([
    ["Google (YouTube) access_denied", "youtube", { error: "access_denied" }, "cancelled"],
    ["Google (Business Profile) access_denied", "google_business_profile", { error: "access_denied" }, "cancelled"],
    ["LinkedIn user_cancelled_login", "linkedin", { error: "user_cancelled_login" }, "cancelled"],
    ["LinkedIn user_cancelled_authorize", "linkedin", { error: "user_cancelled_authorize" }, "cancelled"],
    ["LinkedIn unauthorized_scope_error", "linkedin", { error: "unauthorized_scope_error" }, "connect_failed"],
    ["Meta (Facebook Page) user_denied", "facebook_page", { error: "access_denied", error_reason: "user_denied" }, "cancelled"],
    ["Meta (Instagram) user_denied", "instagram", { error: "access_denied", error_reason: "user_denied" }, "cancelled"],
    ["Pinterest access_denied", "pinterest", { error: "access_denied" }, "cancelled"],
    ["TikTok access_denied", "tiktok", { error: "access_denied" }, "cancelled"],
    ["X denied", "x", { denied: "req-token" }, "cancelled"],
    ["TikTok server_error", "tiktok", { error: "server_error" }, "connect_failed"],
  ])("%s: the platform's answer decides the visitor's sentence, whatever code the callback chose", async (_name, platform, params, outcome) => {
    const res = await CALLBACKS[platform](refusal(platform, params));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c/${TOKEN}?error=${platform}_${outcome}`);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toMatch(/^vs_connect=;/);
  });

  it("a refusal on a flow whose place is already taken still says already connected", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: false });

    const res = await tiktokGET(refusal("tiktok", { error: "access_denied" }));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_already_connected`);
  });
});
