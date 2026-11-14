import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

/**
 * F3 (2026-11-14 review): the two ways a connect starts, with the REAL
 * workspace gate (lib/workspace.ts), only the database, session and cookie
 * stood in for.
 *
 * - Settings (signed in): GET /api/auth/<platform>/start must carry the
 *   workspace the page was rendered for; without it, or with another one, the
 *   start is refused before any state or handshake exists.
 * - The client connect link (/c/[token]): POST /api/connect-link/[token]/start.
 *   It has no rendered workspace (the token decides it) and must keep
 *   starting, whoever is or is not signed in in that browser.
 */

const h = vi.hoisted(() => ({
  currentUser: vi.fn(),
  activeCookie: { value: "ws-1" as string | undefined },
  memberships: vi.fn(),
  memberFindFirst: vi.fn(),
  linkFind: vi.fn(),
  handshakeUpsert: vi.fn(),
  handshakeCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findMany: h.memberships, findFirst: h.memberFindFirst },
    workspaceConnectLink: { findUnique: h.linkFind },
    socialConnection: { findUnique: vi.fn(async () => null) },
    oAuthHandshake: { upsert: h.handshakeUpsert, create: h.handshakeCreate, deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: h.currentUser }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.activeCookie.value ? { value: h.activeCookie.value } : undefined) }),
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { generateInviteToken } from "@/lib/inviteToken";

import { POST as connectLinkStart } from "../connect-link/[token]/start/route";
import { GET as facebookPageStart } from "./facebook_page/start/route";
import { GET as gbpStart } from "./google_business_profile/start/route";
import { GET as instagramStart } from "./instagram/start/route";
import { GET as linkedinStart } from "./linkedin/start/route";
import { GET as pinterestStart } from "./pinterest/start/route";
import { GET as tiktokStart } from "./tiktok/start/route";
import { GET as xStart } from "./x/start/route";
import { GET as youtubeStart } from "./youtube/start/route";

const ORIGIN = "https://app.example.com";
const TOKEN = generateInviteToken().raw;

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

const PLATFORMS: Array<{ platform: Platform; GET: (request: NextRequest) => Promise<Response>; host: string }> = [
  { platform: "youtube", GET: youtubeStart, host: "accounts.google.com" },
  { platform: "x", GET: xStart, host: "api.twitter.com" },
  { platform: "tiktok", GET: tiktokStart, host: "www.tiktok.com" },
  { platform: "pinterest", GET: pinterestStart, host: "www.pinterest.com" },
  { platform: "instagram", GET: instagramStart, host: "www.facebook.com" },
  { platform: "facebook_page", GET: facebookPageStart, host: "www.facebook.com" },
  { platform: "linkedin", GET: linkedinStart, host: "www.linkedin.com" },
  { platform: "google_business_profile", GET: gbpStart, host: "accounts.google.com" },
];

const OWNER = { id: "user-1", email: "owner@example.test", name: "Owner", passwordHash: null };

function ownerOf(workspaceId: string) {
  return {
    id: `member-${workspaceId}`,
    workspaceId,
    userId: OWNER.id,
    role: "owner",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    workspace: { id: workspaceId, name: `Workspace ${workspaceId}`, pausedAt: null, pausedReason: null },
  };
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") as string);
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  h.currentUser.mockReset().mockResolvedValue(OWNER);
  h.activeCookie.value = "ws-1";
  h.memberships.mockReset().mockResolvedValue([ownerOf("ws-1"), ownerOf("ws-2")]);
  h.memberFindFirst.mockReset().mockResolvedValue({ id: "member-link", role: "owner" });
  h.handshakeUpsert.mockReset();
  h.handshakeCreate.mockReset();
  h.linkFind.mockReset().mockResolvedValue({
    id: "link-1",
    workspaceId: "ws-9",
    createdById: "user-creator",
    platforms: PLATFORMS.map((p) => p.platform),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    workspace: { name: "Client Co", pausedAt: null, pausedReason: null },
  });
  // X asks for a request token before it redirects; nothing else fetches.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("oauth_token=req-token&oauth_token_secret=req-secret")),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings: a signed-in start", () => {
  it.each(PLATFORMS)("$platform with the page's workspace id goes to the platform", async ({ platform, GET, host }) => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/${platform}/start?workspaceId=ws-1`));

    expect(location(res).host).toBe(host);
  });

  it.each(PLATFORMS)("$platform without ?workspaceId is refused before any state or handshake", async ({ platform, GET }) => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/${platform}/start`));

    expect(location(res).toString()).toBe(`${ORIGIN}/settings?error=${platform}_workspace_changed`);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.handshakeUpsert).not.toHaveBeenCalled();
  });

  it.each(PLATFORMS)("$platform from a tab rendered for another workspace is refused", async ({ platform, GET }) => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/${platform}/start?workspaceId=ws-2`));

    expect(location(res).toString()).toBe(`${ORIGIN}/settings?error=${platform}_workspace_changed`);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.handshakeUpsert).not.toHaveBeenCalled();
  });
});

describe("the client connect link (/c/[token]): no rendered workspace, the token decides", () => {
  const press = (platform: Platform) =>
    connectLinkStart(
      new NextRequest(`${ORIGIN}/api/connect-link/${TOKEN}/start`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ platform }).toString(),
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );

  it.each(PLATFORMS)("$platform starts for a signed-out visitor", async ({ platform, host }) => {
    h.currentUser.mockResolvedValue(null);
    h.activeCookie.value = undefined;

    const res = await press(platform);

    expect(res.status).toBe(303);
    expect(location(res).host).toBe(host);
  });

  it.each(PLATFORMS)(
    "$platform starts in a browser signed in to another workspace, with no ?workspaceId",
    async ({ platform, host }) => {
      h.activeCookie.value = "ws-2";

      const res = await press(platform);

      expect(res.status).toBe(303);
      expect(location(res).host).toBe(host);
    },
  );
});
