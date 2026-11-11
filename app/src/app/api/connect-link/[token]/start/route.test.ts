import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

/**
 * POST /api/connect-link/[token]/start (16): the visitor's Connect press. A
 * plain same-origin form; it sets the sealed cookie and answers 303 to the
 * platform's authorize address, which must equal the start route's except
 * for `state`.
 */

const h = vi.hoisted(() => ({
  linkFind: vi.fn(),
  connectionFind: vi.fn(),
  handshakeCreate: vi.fn(),
  isOwner: vi.fn(),
  ownerContext: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceConnectLink: { findUnique: h.linkFind },
    socialConnection: { findUnique: h.connectionFind },
    oAuthHandshake: { create: h.handshakeCreate, upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: h.isOwner, requireOwnerContextForOAuthStart: h.ownerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET as facebookPageStart } from "@/app/api/auth/facebook_page/start/route";
import { GET as gbpStart } from "@/app/api/auth/google_business_profile/start/route";
import { GET as instagramStart } from "@/app/api/auth/instagram/start/route";
import { GET as linkedinStart } from "@/app/api/auth/linkedin/start/route";
import { GET as pinterestStart } from "@/app/api/auth/pinterest/start/route";
import { GET as tiktokStart } from "@/app/api/auth/tiktok/start/route";
import { GET as youtubeStart } from "@/app/api/auth/youtube/start/route";
import { generateInviteToken } from "@/lib/inviteToken";
import { verifyOAuthState } from "@/lib/oauthState";
import { openConnectCookie } from "@/server/connectLink/cookie";

import { POST } from "./route";

const ORIGIN = "https://app.example.com";
const NOW = new Date("2026-11-11T08:00:00Z");
const TOKEN = generateInviteToken().raw;
const ALL: Platform[] = ["tiktok", "youtube", "google_business_profile", "instagram", "facebook_page", "linkedin", "pinterest", "x"];

const ENV: Record<string, string> = {
  NEXTAUTH_SECRET: "test-secret",
  NEXTAUTH_URL: ORIGIN,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  TIKTOK_REDIRECT_URI: `${ORIGIN}/api/auth/tiktok/callback`,
  GOOGLE_GBP_CLIENT_ID: "g-id",
  GOOGLE_GBP_CLIENT_SECRET: "g-secret",
  GOOGLE_GBP_REDIRECT_URI: `${ORIGIN}/api/auth/google_business_profile/callback`,
  YOUTUBE_REDIRECT_URI: `${ORIGIN}/api/auth/youtube/callback`,
  FACEBOOK_APP_ID: "fb-id",
  FACEBOOK_APP_SECRET: "fb-secret",
  INSTAGRAM_REDIRECT_URI: `${ORIGIN}/api/auth/instagram/callback`,
  FACEBOOK_PAGE_REDIRECT_URI: `${ORIGIN}/api/auth/facebook_page/callback`,
  LINKEDIN_CLIENT_ID: "li-id",
  LINKEDIN_CLIENT_SECRET: "li-secret",
  LINKEDIN_REDIRECT_URI: `${ORIGIN}/api/auth/linkedin/callback`,
  PINTEREST_APP_ID: "1234567",
  PINTEREST_APP_SECRET: "pin-secret",
  PINTEREST_REDIRECT_URI: `${ORIGIN}/api/auth/pinterest/callback`,
  X_CONSUMER_KEY: "x-key",
  X_CONSUMER_SECRET: "x-secret",
  X_CALLBACK_URL: `${ORIGIN}/api/auth/x/callback`,
};

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    createdById: "user-creator",
    platforms: ALL,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    workspace: { name: "Surf Co", pausedAt: null, pausedReason: null },
    ...overrides,
  };
}

function press(platform: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, token = TOKEN) {
  return POST(
    new NextRequest(`${ORIGIN}/api/connect-link/${token}/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ platform }).toString(),
    }),
    { params: Promise.resolve({ token }) },
  );
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") as string);
}

function sealedCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return decodeURIComponent(header.split(";")[0].replace(/^vs_connect=/, ""));
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  h.linkFind.mockResolvedValue(linkRow());
  h.isOwner.mockResolvedValue(true);
  h.connectionFind.mockResolvedValue(null);
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.ownerContext.mockResolvedValue({ user: { id: "user-creator" }, workspace: { id: "ws-1" }, role: "owner" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("only a deliberate press on our own page starts a flow", () => {
  it.each([
    ["a cross-site form", { "sec-fetch-site": "cross-site" }],
    ["a same-site but other-origin form", { "sec-fetch-site": "same-site" }],
    ["no fetch metadata and another Origin", { origin: "https://evil.example" }],
    ["no fetch metadata and no Origin", {}],
  ])("%s is refused, nothing looked up or set", async (_name, headers) => {
    const res = await press("tiktok", headers);

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.linkFind).not.toHaveBeenCalled();
  });

  it("an Origin equal to the app's own is accepted when fetch metadata is missing", async () => {
    const res = await press("tiktok", { origin: ORIGIN });
    expect(res.status).toBe(303);
  });

  it("is rate limited per network", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await press("tiktok");
    expect(res.status).toBe(429);
    expect(h.rateLimit.mock.calls[0][0]).toMatchObject({ route: "connect-link/start", failClosed: true });
  });
});

describe("a link that does not work", () => {
  it.each([
    ["unknown", () => h.linkFind.mockResolvedValue(null)],
    ["revoked", () => h.linkFind.mockResolvedValue(linkRow({ revokedAt: NOW }))],
    ["expired", () => h.linkFind.mockResolvedValue(linkRow({ expiresAt: NOW }))],
    ["paused", () => h.linkFind.mockResolvedValue(linkRow({ workspace: { name: "S", pausedAt: NOW, pausedReason: null } }))],
  ])("%s: back to the page, which says the link is not active; no cookie", async (_name, arrange) => {
    arrange();
    const res = await press("tiktok");
    expect(res.status).toBe(303);
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a token that is not a token is a 404", async () => {
    const res = await press("tiktok", undefined, "nope");
    expect(res.status).toBe(404);
  });
});

describe("the platform", () => {
  it("not offered by the link: refused, with a sentence on the page", async () => {
    h.linkFind.mockResolvedValue(linkRow({ platforms: ["instagram"] }));
    const res = await press("tiktok");
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_connect_failed`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("not configured on this site: refused", async () => {
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    const res = await press("tiktok");
    expect(location(res).searchParams.get("error")).toBe("tiktok_connect_failed");
  });

  it("not a platform at all: refused", async () => {
    const res = await press("myspace");
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=connect_failed`);
  });

  it("already held by a working account: refused before anything is set", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: false });
    const res = await press("tiktok");
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=tiktok_already_connected`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("held by one that needs reconnecting: allowed", async () => {
    h.connectionFind.mockResolvedValue({ needsReconnect: true });
    const res = await press("tiktok");
    expect(location(res).host).toBe("www.tiktok.com");
  });
});

type Start = (request: NextRequest) => Promise<Response>;
const STARTS: Array<[Exclude<Platform, "x">, Start]> = [
  ["tiktok", tiktokStart as Start],
  ["youtube", youtubeStart],
  ["google_business_profile", gbpStart as Start],
  ["instagram", instagramStart],
  ["facebook_page", facebookPageStart],
  ["linkedin", linkedinStart],
  ["pinterest", pinterestStart as Start],
];

describe.each(STARTS)("%s: a press that starts a flow", (platform, start) => {
  it("answers 303 to the start route's address, except for state", async () => {
    const fromStart = new URL((await start(new NextRequest(`${ORIGIN}/api/auth/${platform}/start`))).headers.get("location") as string);
    const res = await press(platform);
    const fromLink = location(res);

    expect(res.status).toBe(303);
    expect(`${fromLink.origin}${fromLink.pathname}`).toBe(`${fromStart.origin}${fromStart.pathname}`);
    fromStart.searchParams.delete("state");
    const linkState = fromLink.searchParams.get("state") as string;
    fromLink.searchParams.delete("state");
    expect([...fromLink.searchParams.entries()].sort()).toEqual([...fromStart.searchParams.entries()].sort());

    // The state is a link state bound to the cookie's nonce, never an ordinary one.
    const cookie = openConnectCookie(sealedCookie(res));
    expect(cookie).toMatchObject({ linkId: "link-1", token: TOKEN });
    expect(verifyOAuthState(linkState)).toEqual({ valid: false });
    expect(
      verifyOAuthState(linkState, {
        id: "link-1",
        nonce: cookie!.nonce,
        userId: "user-creator",
        workspaceId: "ws-1",
        token: TOKEN,
      }),
    ).toEqual({ valid: true, userId: "user-creator", workspaceId: "ws-1" });
    expect(Buffer.from(linkState, "base64url").toString()).not.toContain(TOKEN);
  });
});

describe("the cookie", () => {
  it("is httpOnly, Secure, SameSite=Lax, path /, 15 minutes, and holds a fresh nonce each press", async () => {
    const first = await press("tiktok");
    const second = await press("tiktok");
    const header = (first.headers.get("set-cookie") ?? "").toLowerCase();

    expect(header).toMatch(/^vs_connect=/);
    for (const part of ["httponly", "secure", "samesite=lax", "path=/", "max-age=900"]) {
      expect(header).toContain(part);
    }
    expect(header).not.toContain(TOKEN.toLowerCase());
    expect(openConnectCookie(sealedCookie(first))!.nonce).not.toBe(openConnectCookie(sealedCookie(second))!.nonce);
  });
});

describe("x", () => {
  it("asks X for a request token, writes the handshake row with the link columns, and sends the visitor to X", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oauth_token=req-token&oauth_token_secret=req-secret")),
    );

    const res = await press("x");

    expect(res.status).toBe(303);
    expect(location(res).toString()).toBe("https://api.twitter.com/oauth/authorize?oauth_token=req-token");
    const cookie = openConnectCookie(sealedCookie(res));
    expect(h.handshakeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        token: "req-token",
        userId: "user-creator",
        workspaceId: "ws-1",
        connectLinkId: "link-1",
        connectLinkNonce: cookie!.nonce,
      }),
    });
  });

  it("X refusing is a sentence on the page, and no cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const res = await press("x");
    expect(location(res).toString()).toBe(`${ORIGIN}/c/${TOKEN}?error=x_connect_failed`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

// Fix round 1: one link may start at most 60 flows an hour, from any number
// of networks, so it cannot be used to make unlimited X request-token calls.
describe("the per-link start limit", () => {
  const LINK_ROUTE = "connect-link/start-link";
  const limitOnly = (blocked: (opts: { userId: string; route: string }) => boolean) =>
    h.rateLimit.mockImplementation(async (opts: { userId: string; route: string }) =>
      blocked(opts) ? { allowed: false, retryAfterSeconds: 120 } : { allowed: true },
    );

  it("under the cap a press starts as before, the per-IP limit checked first, then the link's", async () => {
    const res = await press("tiktok");

    expect(res.status).toBe(303);
    expect(h.rateLimit.mock.calls.map(([opts]) => opts.route)).toEqual(["connect-link/start", LINK_ROUTE]);
    expect(h.rateLimit.mock.calls[1][0]).toMatchObject({ limit: 60, windowMs: 60 * 60 * 1000, failClosed: true });
  });

  it("over the link's cap from a fresh network: the same 429, nothing sent to a platform, no cookie", async () => {
    const fetchMock = vi.fn(async () => new Response("oauth_token=t&oauth_token_secret=s"));
    vi.stubGlobal("fetch", fetchMock);
    limitOnly(({ route }) => route === LINK_ROUTE);

    const res = await press("x", { "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" });

    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Too many requests from this network in the last hour. Try again later.");
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.handshakeCreate).not.toHaveBeenCalled();
  });

  it("another link is not affected", async () => {
    limitOnly(({ route, userId }) => route === LINK_ROUTE && userId.includes("link-1"));
    h.linkFind.mockResolvedValue(linkRow({ id: "link-2" }));

    const res = await press("tiktok");

    expect(res.status).toBe(303);
  });

  it("is keyed by the link id, never the raw token", async () => {
    await press("tiktok");

    const key = h.rateLimit.mock.calls[1][0].userId as string;
    expect(key).toContain("link-1");
    expect(key).not.toContain(TOKEN);
    for (const [opts] of h.rateLimit.mock.calls) expect(JSON.stringify(opts)).not.toContain(TOKEN);
  });
});
