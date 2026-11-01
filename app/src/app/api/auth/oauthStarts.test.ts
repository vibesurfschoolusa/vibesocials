import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Platform } from "@prisma/client";

// The state-based OAuth start routes (`./<platform>/start/route.ts`): an
// unconfigured platform redirects to /settings with
// `<platform>_not_configured` (shown by lib/oauthResult.ts), never a raw JSON
// 500. Start routes only build the provider URL; nothing is fetched.
const { requireOwnerContextForOAuthStartMock } = vi.hoisted(() => ({
  requireOwnerContextForOAuthStartMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  requireOwnerContextForOAuthStart: requireOwnerContextForOAuthStartMock,
}));

import { GET as facebookPageStart } from "./facebook_page/start/route";
import { GET as gbpStart } from "./google_business_profile/start/route";
import { GET as instagramStart } from "./instagram/start/route";
import { GET as tiktokStart } from "./tiktok/start/route";
import { GET as youtubeStart } from "./youtube/start/route";

const ORIGIN = "https://app.example.com";

interface StartCase {
  platform: Platform;
  GET: (request: NextRequest) => Promise<Response>;
  /** Env vars the start route requires; each is blanked in turn. */
  env: Record<string, string>;
  authorizeHost: string;
}

const CASES: StartCase[] = [
  {
    platform: "youtube",
    GET: youtubeStart,
    env: { GOOGLE_GBP_CLIENT_ID: "g-id", YOUTUBE_REDIRECT_URI: `${ORIGIN}/api/auth/youtube/callback` },
    authorizeHost: "accounts.google.com",
  },
  {
    platform: "instagram",
    GET: instagramStart,
    env: { FACEBOOK_APP_ID: "fb-id", INSTAGRAM_REDIRECT_URI: `${ORIGIN}/api/auth/instagram/callback` },
    authorizeHost: "www.facebook.com",
  },
  {
    platform: "facebook_page",
    GET: facebookPageStart,
    env: { FACEBOOK_APP_ID: "fb-id", FACEBOOK_PAGE_REDIRECT_URI: `${ORIGIN}/api/auth/facebook_page/callback` },
    authorizeHost: "www.facebook.com",
  },
  // Already redirected before this change; kept here as the reference shape.
  {
    platform: "tiktok",
    GET: tiktokStart,
    env: { TIKTOK_CLIENT_KEY: "tt-key", TIKTOK_REDIRECT_URI: `${ORIGIN}/api/auth/tiktok/callback` },
    authorizeHost: "www.tiktok.com",
  },
  {
    platform: "google_business_profile",
    GET: gbpStart,
    env: {
      GOOGLE_GBP_CLIENT_ID: "g-id",
      GOOGLE_GBP_REDIRECT_URI: `${ORIGIN}/api/auth/google_business_profile/callback`,
    },
    authorizeHost: "accounts.google.com",
  },
];

function startRequest(platform: Platform): NextRequest {
  return new NextRequest(new URL(`/api/auth/${platform}/start`, ORIGIN));
}

beforeEach(() => {
  requireOwnerContextForOAuthStartMock.mockReset();
  requireOwnerContextForOAuthStartMock.mockResolvedValue({
    user: { id: "user-1" },
    workspace: { id: "ws-1" },
    role: "owner",
  });
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(CASES)("$platform OAuth start", ({ platform, GET, env, authorizeHost }) => {
  it.each(Object.keys(env))(
    "redirects to /settings?error=<platform>_not_configured when %s is missing",
    async (missing) => {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, key === missing ? "" : value);
      }

      const res = await GET(startRequest(platform));

      expect(res.status).toBe(307);
      const loc = new URL(res.headers.get("location") as string);
      expect(loc.origin).toBe(ORIGIN);
      expect(loc.pathname).toBe("/settings");
      expect(loc.searchParams.get("error")).toBe(`${platform}_not_configured`);
    },
  );

  it("redirects to the provider with a signed state when configured", async () => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    const res = await GET(startRequest(platform));

    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.host).toBe(authorizeHost);
    expect(loc.searchParams.get("state")).toBeTruthy();
  });
});
