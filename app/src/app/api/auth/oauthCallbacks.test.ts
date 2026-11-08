import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Platform } from "@prisma/client";

// Table-driven coverage for the six state-based OAuth callbacks
// (`./<platform>/callback/route.ts`). X uses an OAuthHandshake row instead of
// a signed state and has its own colocated route.test.ts.
//
// `@/lib/oauthState` is kept REAL (NEXTAUTH_SECRET is stubbed) so each test
// carries a genuinely signed state. `fetch` is stubbed globally: no test ever
// reaches a real provider.
const {
  getCurrentUserMock,
  isWorkspaceOwnerMock,
  upsertMock,
  findUniqueMock,
  createMock,
  updateMock,
  updateManyMock,
  deleteMock,
  deleteManyMock,
  fetchMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  isWorkspaceOwnerMock: vi.fn(),
  upsertMock: vi.fn(),
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  deleteMock: vi.fn(),
  deleteManyMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/workspace", () => ({
  isWorkspaceOwner: isWorkspaceOwnerMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      upsert: upsertMock,
      findUnique: findUniqueMock,
      create: createMock,
      update: updateMock,
      updateMany: updateManyMock,
      delete: deleteMock,
      deleteMany: deleteManyMock,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createOAuthState } from "@/lib/oauthState";
import { GET as facebookPageGET } from "./facebook_page/callback/route";
import { GET as gbpGET } from "./google_business_profile/callback/route";
import { GET as instagramGET } from "./instagram/callback/route";
import { GET as linkedinGET } from "./linkedin/callback/route";
import { GET as tiktokGET } from "./tiktok/callback/route";
import { GET as youtubeGET } from "./youtube/callback/route";

const ORIGIN = "https://app.example.com";
const STATE_USER = "user-owner";
const STATE_WORKSPACE = "ws-1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Per-platform fake provider: answers each provider URL the callback calls on
 * its happy path with the minimum it reads.
 */
type FakeProvider = (url: string) => Response;

interface CallbackCase {
  platform: Platform;
  GET: (request: NextRequest) => Promise<Response>;
  provider: FakeProvider;
}

const CASES: CallbackCase[] = [
  {
    platform: "tiktok",
    GET: tiktokGET,
    provider: () =>
      json({ access_token: "tt-access", open_id: "open-1", scope: "user.info.basic", token_type: "Bearer" }),
  },
  {
    platform: "youtube",
    GET: youtubeGET,
    provider: (url) =>
      url.includes("youtube/v3/channels")
        ? json({ items: [{ id: "chan-1", snippet: { title: "My Channel" } }] })
        : json({ access_token: "yt-access", expires_in: 3600, token_type: "Bearer" }),
  },
  {
    platform: "google_business_profile",
    GET: gbpGET,
    provider: () => json({ access_token: "gbp-access", token_type: "Bearer" }),
  },
  {
    platform: "instagram",
    GET: instagramGET,
    provider: (url) => {
      if (url.includes("/me/accounts")) {
        return json({
          data: [
            { id: "page-1", name: "Page", access_token: "page-token", instagram_business_account: { id: "ig-1" } },
          ],
        });
      }
      if (url.includes("/ig-1")) return json({ username: "brand" });
      return json({ access_token: "fb-user-token", expires_in: 5184000 });
    },
  },
  {
    platform: "facebook_page",
    GET: facebookPageGET,
    provider: (url) =>
      url.includes("/me/accounts")
        ? json({ data: [{ id: "page-1", name: "Page", access_token: "page-token" }] })
        : json({ access_token: "fb-user-token", expires_in: 5184000 }),
  },
  {
    platform: "linkedin",
    GET: linkedinGET,
    provider: (url) => {
      if (url.includes("oauth/v2/accessToken")) {
        return json({ access_token: "li-access", expires_in: 3600, scope: "w_organization_social" });
      }
      if (url.includes("organizationalEntityAcls")) {
        return json({
          elements: [{ "organizationalTarget~": { id: "org-1", localizedName: "Org" } }],
        });
      }
      return json({ id: "member-1", localizedFirstName: "A", localizedLastName: "B" });
    },
  },
];

function callbackRequest(platform: Platform, state: string, code = "auth-code"): NextRequest {
  const url = new URL(`/api/auth/${platform}/callback`, ORIGIN);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return new NextRequest(url);
}

function signedState(): string {
  return createOAuthState({ userId: STATE_USER, workspaceId: STATE_WORKSPACE });
}

function location(res: Response): URL {
  const raw = res.headers.get("location");
  expect(raw).toBeTruthy();
  return new URL(raw as string);
}

function expectNoConnectionWrites() {
  for (const write of [upsertMock, createMock, updateMock, updateManyMock, deleteMock, deleteManyMock]) {
    expect(write).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  for (const m of [
    getCurrentUserMock,
    isWorkspaceOwnerMock,
    upsertMock,
    findUniqueMock,
    createMock,
    updateMock,
    updateManyMock,
    deleteMock,
    deleteManyMock,
    fetchMock,
  ]) {
    m.mockReset();
  }

  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("TIKTOK_CLIENT_KEY", "tt-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "tt-secret");
  vi.stubEnv("TIKTOK_REDIRECT_URI", `${ORIGIN}/api/auth/tiktok/callback`);
  vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g-id");
  vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "g-secret");
  vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", `${ORIGIN}/api/auth/google_business_profile/callback`);
  vi.stubEnv("YOUTUBE_REDIRECT_URI", `${ORIGIN}/api/auth/youtube/callback`);
  vi.stubEnv("FACEBOOK_APP_ID", "fb-id");
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
  vi.stubEnv("FACEBOOK_PAGE_ID", "");
  vi.stubEnv("INSTAGRAM_REDIRECT_URI", `${ORIGIN}/api/auth/instagram/callback`);
  vi.stubEnv("FACEBOOK_PAGE_REDIRECT_URI", `${ORIGIN}/api/auth/facebook_page/callback`);
  vi.stubEnv("LINKEDIN_CLIENT_ID", "li-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "li-secret");
  vi.stubEnv("LINKEDIN_REDIRECT_URI", `${ORIGIN}/api/auth/linkedin/callback`);
  vi.stubGlobal("fetch", fetchMock);

  // The routes still log provider progress through console.*; keep test
  // output pristine.
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }

  isWorkspaceOwnerMock.mockResolvedValue(true);
  findUniqueMock.mockResolvedValue(null);
  upsertMock.mockResolvedValue({ id: "conn-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(CASES)("$platform OAuth callback: session binding", ({ platform, GET, provider }) => {
  it("with no session, redirects to /login?callbackUrl=%2Fsettings and never exchanges the code or writes", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await GET(callbackRequest(platform, signedState()));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?callbackUrl=%2Fsettings`);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoConnectionWrites();
  });

  it("when the signed-in user is not the user who started the flow, redirects with oauth_session_mismatch and never exchanges the code or writes", async () => {
    // The attacker started the flow (state user); the victim's browser
    // completes it while signed in as someone else.
    getCurrentUserMock.mockResolvedValue({ id: "user-victim" });

    const res = await GET(callbackRequest(platform, signedState()));

    const loc = location(res);
    expect(loc.origin).toBe(ORIGIN);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("oauth_session_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isWorkspaceOwnerMock).not.toHaveBeenCalled();
    expectNoConnectionWrites();
  });

  it("when the signed-in user started the flow, connects the state's workspace (session checked before the code exchange)", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    fetchMock.mockImplementation(async (input: string | URL) => provider(String(input)));

    const res = await GET(callbackRequest(platform, signedState()));

    expect(location(res).searchParams.get("success")).toBe(`${platform}_connected`);
    expect(getCurrentUserMock).toHaveBeenCalledTimes(1);
    expect(getCurrentUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0] as {
      where: { workspaceId_platform: { workspaceId: string; platform: string } };
      create: { userId: string; workspaceId: string };
    };
    expect(args.where.workspaceId_platform).toEqual({ workspaceId: STATE_WORKSPACE, platform });
    expect(args.create.userId).toBe(STATE_USER);
    expect(args.create.workspaceId).toBe(STATE_WORKSPACE);
  });

  it("keeps the owner re-check: a matching session that is no longer owner is refused before the exchange", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    isWorkspaceOwnerMock.mockResolvedValue(false);

    const res = await GET(callbackRequest(platform, signedState()));

    expect(location(res).searchParams.get("error")).toBe(`${platform}_not_workspace_owner`);
    expect(isWorkspaceOwnerMock).toHaveBeenCalledWith(STATE_USER, STATE_WORKSPACE);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoConnectionWrites();
  });

  it("an invalid state is still rejected before any session lookup", async () => {
    const res = await GET(callbackRequest(platform, "not-a-signed-state"));

    expect(location(res).searchParams.get("error")).toMatch(/invalid_state$/);
    expect(getCurrentUserMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("unexpected errors redirect to <platform>_connect_failed instead of a 500", () => {
    it("session lookup (DB) failure", async () => {
      getCurrentUserMock.mockRejectedValue(new Error("db down"));

      const res = await GET(callbackRequest(platform, signedState()));

      expect(location(res).searchParams.get("error")).toBe(`${platform}_connect_failed`);
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoConnectionWrites();
    });

    it("owner re-check (DB) failure", async () => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      isWorkspaceOwnerMock.mockRejectedValue(new Error("db down"));

      const res = await GET(callbackRequest(platform, signedState()));

      expect(location(res).searchParams.get("error")).toBe(`${platform}_connect_failed`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("network failure on the token exchange", async () => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const res = await GET(callbackRequest(platform, signedState()));

      expect(location(res).searchParams.get("error")).toBe(`${platform}_connect_failed`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectNoConnectionWrites();
    });

    it("unparseable token-endpoint JSON", async () => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      fetchMock.mockImplementation(async () => new Response("<html>oops</html>", { status: 200 }));

      const res = await GET(callbackRequest(platform, signedState()));

      expect(location(res).searchParams.get("error")).toBe(`${platform}_connect_failed`);
      expectNoConnectionWrites();
    });

    it("DB failure writing the connection", async () => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      fetchMock.mockImplementation(async (input: string | URL) => provider(String(input)));
      upsertMock.mockRejectedValue(new Error("db down"));

      const res = await GET(callbackRequest(platform, signedState()));

      expect(res.status).toBe(307);
      expect(location(res).searchParams.get("error")).toBe(`${platform}_connect_failed`);
    });
  });
});

describe("linkedin OAuth callback: the name Settings shows", () => {
  it("saves the company page's name, so Settings shows it instead of a placeholder member id", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    const linkedin = CASES.find((c) => c.platform === "linkedin")!;
    fetchMock.mockImplementation(async (input: string | URL) => linkedin.provider(String(input)));

    await linkedinGET(callbackRequest("linkedin", signedState()));

    const args = upsertMock.mock.calls[0][0] as {
      create: { metadata: { username?: string | null } };
      update: { metadata: { username?: string | null } };
    };
    expect(args.create.metadata.username).toBe("Org");
    expect(args.update.metadata.username).toBe("Org");
  });
});

describe("linkedin OAuth callback: vanity-name suffix", () => {
  it("binds to the user in the SIGNED part of the state, ignoring the unsigned .vanityName suffix", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-victim" });
    const state = `${signedState()}.${Buffer.from("acme", "utf8").toString("base64url")}`;

    const res = await linkedinGET(callbackRequest("linkedin", state));

    expect(location(res).searchParams.get("error")).toBe("oauth_session_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoConnectionWrites();
  });
});
