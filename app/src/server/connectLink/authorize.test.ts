import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

/**
 * Drift guard (16): a link flow's authorize address is built in new code, not
 * shared with the start routes, so this compares the two. For each platform
 * the existing start route (owner context mocked) and the link builder must
 * send the visitor to the same address with the same query, except `state`.
 */

const h = vi.hoisted(() => ({
  ownerContext: vi.fn(),
  handshakeUpsert: vi.fn(),
  handshakeCreate: vi.fn(),
  handshakeDeleteMany: vi.fn(),
  checkRateLimit: vi.fn(),
}));
// R61 security-billing-2 L1: the owner's X start is limited per person; the
// link flow keeps the connect-link start's own limits (per network, per link).
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContextForOAuthStart: h.ownerContext }));
vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthHandshake: { upsert: h.handshakeUpsert, create: h.handshakeCreate, deleteMany: h.handshakeDeleteMany },
  },
}));

import { GET as facebookPageStart } from "@/app/api/auth/facebook_page/start/route";
import { GET as gbpStart } from "@/app/api/auth/google_business_profile/start/route";
import { GET as instagramStart } from "@/app/api/auth/instagram/start/route";
import { GET as linkedinStart } from "@/app/api/auth/linkedin/start/route";
import { GET as pinterestStart } from "@/app/api/auth/pinterest/start/route";
import { GET as tiktokStart } from "@/app/api/auth/tiktok/start/route";
import { GET as xStart } from "@/app/api/auth/x/start/route";
import { GET as youtubeStart } from "@/app/api/auth/youtube/start/route";

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds, headersNeverCome } from "@/lib/stallingFetch.testkit";

import { buildLinkAuthorizeUrl, startXLinkFlow } from "./authorize";

const ORIGIN = "https://app.example.com";

const ENV: Record<string, string> = {
  NEXTAUTH_SECRET: "test-secret",
  NEXTAUTH_URL: ORIGIN,
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

type Start = (request: NextRequest) => Promise<Response>;

const STATE_PLATFORMS: Array<{ platform: Exclude<Platform, "x">; start: Start }> = [
  { platform: "tiktok", start: tiktokStart as Start },
  { platform: "youtube", start: youtubeStart },
  { platform: "google_business_profile", start: gbpStart as Start },
  { platform: "instagram", start: instagramStart },
  { platform: "facebook_page", start: facebookPageStart },
  { platform: "linkedin", start: linkedinStart },
  { platform: "pinterest", start: pinterestStart as Start },
];

function withoutState(raw: string) {
  const url = new URL(raw);
  const state = url.searchParams.get("state");
  url.searchParams.delete("state");
  return { address: `${url.origin}${url.pathname}`, query: [...url.searchParams.entries()].sort(), state };
}

beforeEach(() => {
  for (const m of Object.values(h)) m.mockReset();
  h.ownerContext.mockResolvedValue({ user: { id: "user-1" }, workspace: { id: "ws-1" }, role: "owner" });
  // The start route's cleanup chains .catch on this, so it must answer a promise.
  h.handshakeDeleteMany.mockResolvedValue({ count: 0 });
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(STATE_PLATFORMS)("$platform: the link's authorize address", ({ platform, start }) => {
  it("equals the start route's in every query parameter except state", async () => {
    const res = await start(new NextRequest(new URL(`/api/auth/${platform}/start`, ORIGIN)));
    const fromStart = withoutState(res.headers.get("location") as string);

    const built = buildLinkAuthorizeUrl(platform, "LINK-STATE");
    expect(built).not.toBeNull();
    const fromLink = withoutState(built as string);

    expect(fromLink.address).toBe(fromStart.address);
    expect(fromLink.query).toEqual(fromStart.query);
    expect(fromStart.state).toBeTruthy();
    expect(fromLink.state).toBe("LINK-STATE");
  });

  it("is null when the platform is not configured", () => {
    vi.stubEnv(platform === "pinterest" ? "PINTEREST_APP_ID" : platform === "tiktok" ? "TIKTOK_CLIENT_KEY" : "FACEBOOK_APP_ID", "");
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "");
    vi.stubEnv("LINKEDIN_CLIENT_ID", "");
    expect(buildLinkAuthorizeUrl(platform, "S")).toBeNull();
  });
});

describe("linkedin: the link never sends the vanity-name suffix", () => {
  it("passes the state exactly as given", () => {
    const built = new URL(buildLinkAuthorizeUrl("linkedin", "ONLY-THIS") as string);
    expect(built.searchParams.get("state")).toBe("ONLY-THIS");
  });
});

describe("x: the request-token call and the handshake row", () => {
  const requestTokenAnswer = () =>
    new Response("oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true");

  it("makes the same request-token call and sends the visitor to the same authorize address", async () => {
    // Above the start route's 1-in-10 cleanup, so both calls take the same path every run.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(async () => requestTokenAnswer());
    vi.stubGlobal("fetch", fetchMock);

    const res = await xStart(new Request(`${ORIGIN}/api/auth/x/start`));
    const startCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const startLocation = res.headers.get("location");

    fetchMock.mockClear();
    const location = await startXLinkFlow({ linkId: "link-1", nonce: "nonce-1", userId: "user-1", workspaceId: "ws-1" });
    const linkCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(location).toBe(startLocation);
    expect(linkCall[0]).toBe(startCall[0]);
    expect(linkCall[1].method).toBe(startCall[1].method);
    const params = (init: RequestInit) =>
      String((init.headers as Record<string, string>).Authorization)
        .replace(/^OAuth /, "")
        .split(", ")
        .map((pair) => pair.split("=")[0])
        .sort();
    expect(params(linkCall[1])).toEqual(params(startCall[1]));
    expect(String((linkCall[1].headers as Record<string, string>).Authorization)).toContain(
      `oauth_callback="${encodeURIComponent(ENV.X_CALLBACK_URL)}"`,
    );
  });

  // P1 fix round 1: the start route deletes expired handshakes on about one start in ten
  // (Math.random() < 0.1). The bare vi.fn() for deleteMany answered undefined, so on those
  // runs `.catch` threw and the route redirected to x_unexpected_error: this test failed
  // about one full run in ten. Forced here, and deleteMany now answers a promise.
  it("compares the same way on a start that also cleans up expired handshakes", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    vi.stubGlobal("fetch", vi.fn(async () => requestTokenAnswer()));
    const res = await xStart(new Request(`${ORIGIN}/api/auth/x/start`));
    expect(res.headers.get("location")).toBe("https://api.twitter.com/oauth/authorize?oauth_token=req-token");
    expect(h.handshakeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("writes the handshake row as the creator, with the link id and nonce, for 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T08:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => requestTokenAnswer()));

    await startXLinkFlow({ linkId: "link-1", nonce: "nonce-1", userId: "user-1", workspaceId: "ws-1" });

    expect(h.handshakeCreate).toHaveBeenCalledWith({
      data: {
        token: "req-token",
        tokenSecret: "req-secret",
        userId: "user-1",
        workspaceId: "ws-1",
        expiresAt: new Date("2026-11-11T08:10:00Z"),
        connectLinkId: "link-1",
        connectLinkNonce: "nonce-1",
      },
    });
    vi.useRealTimers();
  });

  // R61 security-billing-2 L1: the per-person limit is the owner's Connect
  // from Settings only. A client on /c has no signed-in owner; the link
  // flow never reaches the start route, so the new limit never refuses it.
  it("the new limit: an owner's Connect is limited by their user id; a link-flow start is not refused by it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => requestTokenAnswer()));
    h.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });

    const owner = await xStart(new Request(`${ORIGIN}/api/auth/x/start`));
    expect(owner.headers.get("location")).toBe(`${ORIGIN}/settings?error=x_too_many_tries`);
    expect(h.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", route: "auth/x/start" }));

    h.checkRateLimit.mockClear();
    const location = await startXLinkFlow({ linkId: "link-1", nonce: "nonce-1", userId: "user-1", workspaceId: "ws-1" });
    expect(location).toBe("https://api.twitter.com/oauth/authorize?oauth_token=req-token");
    expect(h.checkRateLimit).not.toHaveBeenCalled();
  });

  it("answers null, and writes nothing, when X refuses or is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    expect(await startXLinkFlow({ linkId: "l", nonce: "n", userId: "u", workspaceId: "w" })).toBeNull();
    vi.stubEnv("X_CALLBACK_URL", "");
    expect(await startXLinkFlow({ linkId: "l", nonce: "n", userId: "u", workspaceId: "w" })).toBeNull();
    expect(h.handshakeCreate).not.toHaveBeenCalled();
  });
});

// R36 platform-clients L1 (lead follow-up): X's request token is asked for
// while someone waits on Connect. A stall (no headers, or a body that never
// ends) ends within 15 s in each one's existing failure path: Settings'
// x_unexpected_error for the start route; a throw for the link flow, which the
// connect-link start route turns into the /c page's x_connect_failed.
describe("x: an X that stalls on the request token", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const stall of [
    { kind: "no headers", fetch: headersNeverCome },
    { kind: "a body that never ends", fetch: bodyNeverEnds },
  ]) {
    it(`the start route sends Settings x_unexpected_error after 15 seconds of ${stall.kind}`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abortSignalTimeoutOnFakeClock();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      vi.stubGlobal("fetch", vi.fn(stall.fetch));

      const pending = xStart(new Request(`${ORIGIN}/api/auth/x/start`));
      await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
      const res = await pending;

      expect(res.headers.get("location")).toBe(`${ORIGIN}/settings?error=x_unexpected_error`);
      expect(h.handshakeUpsert).not.toHaveBeenCalled();
    });

    it(`the link flow throws after 15 seconds of ${stall.kind}, and writes nothing`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abortSignalTimeoutOnFakeClock();
      vi.stubGlobal("fetch", vi.fn(stall.fetch));

      const answer = startXLinkFlow({ linkId: "l", nonce: "n", userId: "u", workspaceId: "w" });
      const settled = expect(answer).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
      await settled;
      expect(h.handshakeCreate).not.toHaveBeenCalled();
    });
  }
});
