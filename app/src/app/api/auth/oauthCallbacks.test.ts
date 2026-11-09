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
  pendingCreateMock,
  pendingDeleteManyMock,
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
  pendingCreateMock: vi.fn(),
  pendingDeleteManyMock: vi.fn(),
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
    // 2026-11-09: several accounts park the connect here for the user to choose.
    pendingConnection: {
      create: pendingCreateMock,
      deleteMany: pendingDeleteManyMock,
    },
    $transaction: (operations: Array<Promise<unknown>>) => Promise.all(operations),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createOAuthState } from "@/lib/oauthState";
import { openSecret } from "@/lib/tokenCrypto";
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
  for (const write of [
    upsertMock,
    createMock,
    updateMock,
    updateManyMock,
    deleteMock,
    deleteManyMock,
    pendingCreateMock,
    pendingDeleteManyMock,
  ]) {
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
    pendingCreateMock,
    pendingDeleteManyMock,
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
  pendingCreateMock.mockResolvedValue({ id: "pending-1" });
  pendingDeleteManyMock.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
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

// ---------------------------------------------------------------------------
// 2026-11-09: choosing which account to connect. One Facebook Page / Instagram
// account / LinkedIn page connects straight away, exactly as before (the
// upserts below are pinned field by field). Several park the connect in a
// sealed PendingConnection and send the user to /settings?choose=<id>. The
// app-wide FACEBOOK_PAGE_ID / LINKEDIN_ORGANIZATION_ID overrides are gone.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-09T12:00:00.000Z");
const TEST_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
const HEALTHY = { needsReconnect: false, lastRefreshErrorCode: null, refreshFailedAt: null };

function facebookProvider(pages: Array<Record<string, unknown>>): FakeProvider {
  return (url) =>
    url.includes("/me/accounts")
      ? json({ data: pages })
      : json({ access_token: "fb-user-token", expires_in: 5184000 });
}

/** `usernames`: the Instagram accounts whose details Graph returns; any other ig-N fails. */
function instagramProvider(
  pages: Array<Record<string, unknown>>,
  usernames: Record<string, string>,
): FakeProvider {
  return (url) => {
    if (url.includes("/me/accounts")) return json({ data: pages });
    const igId = Object.keys(usernames).find((id) => url.includes(`/${id}?`));
    if (igId) return json({ username: usernames[igId] });
    if (/\/ig-\d+\?/.test(url)) return json({ error: { message: "Unsupported get request" } }, 400);
    return json({ access_token: "fb-user-token", expires_in: 5184000 });
  };
}

/** Strategy 1 answers `aclElements`; Strategies 2 and 3 are refused. */
function linkedinProvider(aclElements: Array<Record<string, unknown>>): FakeProvider {
  return (url) => {
    if (url.includes("oauth/v2/accessToken")) {
      return json({ access_token: "li-access", expires_in: 3600, scope: "w_organization_social" });
    }
    if (url.includes("organizationalEntityAcls")) return json({ elements: aclElements });
    if (url.includes("/organizations")) return json({ message: "Not enough permissions" }, 403);
    return json({ id: "member-1", localizedFirstName: "A", localizedLastName: "B" });
  };
}

function useProvider(provider: FakeProvider) {
  fetchMock.mockImplementation(async (input: string | URL) => provider(String(input)));
}

/** The one PendingConnection the callback created, with its payload opened. */
function createdPending() {
  expect(pendingCreateMock).toHaveBeenCalledTimes(1);
  const { data } = pendingCreateMock.mock.calls[0][0] as {
    data: { workspaceId: string; userId: string; platform: string; payload: string; expiresAt: Date };
  };
  return { ...data, opened: JSON.parse(openSecret(data.payload)) as Record<string, unknown> };
}

function expectChooseRedirect(res: Response) {
  const loc = location(res);
  expect(loc.origin).toBe(ORIGIN);
  expect(loc.pathname).toBe("/settings");
  expect(loc.searchParams.get("choose")).toBe("pending-1");
  expect(loc.searchParams.get("success")).toBeNull();
}

describe("choosing which account to connect", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", TEST_TOKEN_KEY);
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
  });

  describe("facebook_page", () => {
    it("one Page connects straight away, with the same upsert as before", async () => {
      useProvider(facebookProvider([{ id: "page-1", name: "Page", access_token: "page-token" }]));

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expect(location(res).searchParams.get("success")).toBe("facebook_page_connected");
      expect(pendingCreateMock).not.toHaveBeenCalled();
      const fields = {
        accessToken: "page-token",
        refreshToken: null,
        expiresAt: new Date(NOW.getTime() + 5184000 * 1000),
        accountIdentifier: "page-1",
        metadata: { pageName: "Page" },
        ...HEALTHY,
      };
      expect(upsertMock).toHaveBeenCalledWith({
        where: { workspaceId_platform: { workspaceId: STATE_WORKSPACE, platform: "facebook_page" } },
        update: fields,
        create: { userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform: "facebook_page", ...fields },
      });
    });

    it("several Pages connect none: a sealed PendingConnection holds them and Settings asks which", async () => {
      // FACEBOOK_PAGE_ID used to pick a Page app-wide; it is ignored now.
      vi.stubEnv("FACEBOOK_PAGE_ID", "page-2");
      useProvider(
        facebookProvider([
          { id: "page-1", name: "My Surf School", access_token: "page-token-1" },
          { id: "page-2", name: "Client Cafe", access_token: "page-token-2" },
        ]),
      );

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expectChooseRedirect(res);
      expect(upsertMock).not.toHaveBeenCalled();

      const pending = createdPending();
      expect(pending.workspaceId).toBe(STATE_WORKSPACE);
      expect(pending.userId).toBe(STATE_USER);
      expect(pending.platform).toBe("facebook_page");
      expect(pending.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60 * 1000));
      expect(pending.payload.startsWith("enc:v1:")).toBe(true);
      expect(pending.payload).not.toContain("page-token");
      expect(pending.opened).toEqual({
        platform: "facebook_page",
        expiresAt: new Date(NOW.getTime() + 5184000 * 1000).toISOString(),
        pages: [
          { id: "page-1", name: "My Surf School", accessToken: "page-token-1" },
          { id: "page-2", name: "Client Cafe", accessToken: "page-token-2" },
        ],
      });

      // A newer connect replaces this user's older pending one for the platform.
      expect(pendingDeleteManyMock).toHaveBeenCalledWith({
        where: {
          workspaceId: STATE_WORKSPACE,
          userId: STATE_USER,
          OR: [{ platform: "facebook_page" }, { expiresAt: { lte: NOW } }],
        },
      });
    });
  });

  describe("instagram", () => {
    it("one Page with an Instagram account connects straight away, with the same upsert as before", async () => {
      useProvider(
        instagramProvider(
          [
            { id: "page-1", name: "Page", access_token: "page-token", instagram_business_account: { id: "ig-1" } },
            { id: "page-2", name: "No IG", access_token: "page-token-2" },
          ],
          { "ig-1": "brand" },
        ),
      );

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expect(location(res).searchParams.get("success")).toBe("instagram_connected");
      expect(pendingCreateMock).not.toHaveBeenCalled();
      const fields = {
        accessToken: "page-token",
        refreshToken: null,
        expiresAt: new Date(NOW.getTime() + 5184000 * 1000),
        accountIdentifier: "ig-1",
        metadata: { username: "brand", profilePicture: null, pageId: "page-1" },
        ...HEALTHY,
      };
      expect(upsertMock).toHaveBeenCalledWith({
        where: { workspaceId_platform: { workspaceId: STATE_WORKSPACE, platform: "instagram" } },
        update: fields,
        create: { userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform: "instagram", ...fields },
      });
    });

    it("still refuses when the one account's details can't be read", async () => {
      useProvider(
        instagramProvider(
          [{ id: "page-1", name: "Page", access_token: "page-token", instagram_business_account: { id: "ig-1" } }],
          {},
        ),
      );

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expect(location(res).searchParams.get("error")).toBe("instagram_failed_to_fetch_ig_account");
      expectNoConnectionWrites();
    });

    it("several Instagram accounts connect none: the list shows each username it could read", async () => {
      useProvider(
        instagramProvider(
          [
            { id: "page-1", name: "My Surf School", access_token: "page-token-1", instagram_business_account: { id: "ig-1" } },
            { id: "page-2", name: "No IG", access_token: "page-token-2" },
            { id: "page-3", name: "Client Cafe", access_token: "page-token-3", instagram_business_account: { id: "ig-3" } },
          ],
          // ig-3's details fail: that row falls back to its Page name.
          { "ig-1": "mysurfschool" },
        ),
      );

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expectChooseRedirect(res);
      expect(upsertMock).not.toHaveBeenCalled();
      const pending = createdPending();
      expect(pending.platform).toBe("instagram");
      expect(pending.payload).not.toContain("page-token");
      expect(pending.opened).toEqual({
        platform: "instagram",
        expiresAt: new Date(NOW.getTime() + 5184000 * 1000).toISOString(),
        accounts: [
          {
            igAccountId: "ig-1",
            pageId: "page-1",
            pageName: "My Surf School",
            pageAccessToken: "page-token-1",
            username: "mysurfschool",
          },
          {
            igAccountId: "ig-3",
            pageId: "page-3",
            pageName: "Client Cafe",
            pageAccessToken: "page-token-3",
            username: null,
          },
        ],
      });
    });
  });

  describe("linkedin", () => {
    it("one organization connects straight away, with the same upsert as before", async () => {
      useProvider(linkedinProvider([{ "organizationalTarget~": { id: "org-1", localizedName: "Org" } }]));

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
      expect(pendingCreateMock).not.toHaveBeenCalled();
      const fields = {
        accessToken: "li-access",
        refreshToken: null,
        expiresAt: new Date(NOW.getTime() + 3600 * 1000),
        scopes: "w_organization_social",
        metadata: {
          name: "A B",
          email: null,
          picture: null,
          organizations: [{ id: "org-1", name: "Org" }],
          username: "Org",
        },
        ...HEALTHY,
      };
      expect(upsertMock).toHaveBeenCalledWith({
        where: { workspaceId_platform: { workspaceId: STATE_WORKSPACE, platform: "linkedin" } },
        create: {
          userId: STATE_USER,
          workspaceId: STATE_WORKSPACE,
          platform: "linkedin",
          accountIdentifier: "member-1",
          ...fields,
        },
        update: fields,
      });
    });

    it("several organizations connect none: the member token and the pages wait for the user's choice", async () => {
      useProvider(
        linkedinProvider([
          { "organizationalTarget~": { id: 111, localizedName: "My Surf School", vanityName: "my-surf-school" } },
          { "organizationalTarget~": { id: 222, localizedName: "Client Cafe" } },
        ]),
      );

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expectChooseRedirect(res);
      expect(upsertMock).not.toHaveBeenCalled();
      const pending = createdPending();
      expect(pending.platform).toBe("linkedin");
      expect(pending.payload).not.toContain("li-access");
      expect(pending.opened).toEqual({
        platform: "linkedin",
        token: {
          accessToken: "li-access",
          refreshToken: null,
          expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
          scope: "w_organization_social",
        },
        profile: { sub: "member-1", name: "A B", email: null, picture: null },
        organizations: [
          { id: 111, name: "My Surf School", vanityName: "my-surf-school" },
          { id: 222, name: "Client Cafe" },
        ],
      });
    });

    it("no organizations found: LINKEDIN_ORGANIZATION_ID is no longer a fallback, the user is asked for their page", async () => {
      vi.stubEnv("LINKEDIN_ORGANIZATION_ID", "999");
      vi.stubEnv("LINKEDIN_ORGANIZATION_NAME", "Owner's Page");
      useProvider(linkedinProvider([]));

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expect(location(res).searchParams.get("linkedin_setup")).toBe("true");
      expectNoConnectionWrites();
    });
  });
});
