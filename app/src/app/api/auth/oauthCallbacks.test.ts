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

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { createOAuthState } from "@/lib/oauthState";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds, headersNeverCome } from "@/lib/stallingFetch.testkit";
import { openSecret } from "@/lib/tokenCrypto";
import { GET as facebookPageGET } from "./facebook_page/callback/route";
import { GET as gbpGET } from "./google_business_profile/callback/route";
import { GET as instagramGET } from "./instagram/callback/route";
import { INSTAGRAM_DETAILS_BUDGET_MS } from "@/server/connections/saveConnection";
import { connectPendingCandidate, type PendingConnectionPayload } from "@/server/connections/pendingConnection";
import { GET as linkedinGET } from "./linkedin/callback/route";
import { GET as pinterestGET } from "./pinterest/callback/route";
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
      if (url.includes("/rest/organizationAcls")) {
        return json({
          elements: [
            {
              role: "ADMINISTRATOR",
              organization: "urn:li:organization:101",
              roleAssignee: "urn:li:person:member-1",
              state: "APPROVED",
            },
          ],
          paging: { count: 10, start: 0, links: [] },
        });
      }
      if (url.includes("/rest/organizations/101")) return json({ id: 101, localizedName: "Org" });
      return new Response("not found", { status: 404 });
    },
  },
  {
    platform: "pinterest",
    GET: pinterestGET,
    provider: (url) => pinterestProvider([{ id: "555", name: "Board", privacy: "PUBLIC" }])(url),
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
  vi.stubEnv("PINTEREST_APP_ID", "1234567");
  vi.stubEnv("PINTEREST_APP_SECRET", "pin-secret");
  vi.stubEnv("PINTEREST_REDIRECT_URI", `${ORIGIN}/api/auth/pinterest/callback`);
  vi.stubGlobal("fetch", fetchMock);

  // The routes still log provider progress through console.*; keep test
  // output pristine.
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }

  isWorkspaceOwnerMock.mockResolvedValue(true);
  findUniqueMock.mockResolvedValue(null);
  upsertMock.mockResolvedValue({ id: "conn-1" });
  // The shared save creates a first connection and updates an existing one
  // only while it is still the row it compared (R6 second review 3).
  createMock.mockResolvedValue({ id: "conn-1" });
  updateManyMock.mockResolvedValue({ count: 1 });
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
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0] as { data: { userId: string; workspaceId: string; platform: string } };
    expect(args.data).toMatchObject({ userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform });
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

  // R30 (platform-clients L1): Settings names the row's button only when the
  // code names the platform, so a cancelled Reconnect is told it is unchanged.
  it("the platform's own ?error= (the user said no) comes back with the platform in front", async () => {
    const url = new URL(`/api/auth/${platform}/callback`, ORIGIN);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", signedState());

    const res = await GET(new NextRequest(url));

    // LinkedIn and YouTube send one fixed code for every provider error.
    const expected: Record<string, string> = { linkedin: "linkedin_auth_failed", youtube: "youtube_oauth_denied" };
    expect(location(res).searchParams.get("error")).toBe(expected[platform] ?? `${platform}_access_denied`);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoConnectionWrites();
  });

  it("an odd ?error= value is not passed on: it reads as a provider error of the platform", async () => {
    const url = new URL(`/api/auth/${platform}/callback`, ORIGIN);
    url.searchParams.set("error", "<b>Access Denied</b>");
    url.searchParams.set("state", signedState());

    const res = await GET(new NextRequest(url));

    const fixed: Record<string, string> = {
      linkedin: "linkedin_auth_failed",
      youtube: "youtube_oauth_denied",
    };
    expect(location(res).searchParams.get("error")).toBe(fixed[platform] ?? `${platform}_provider_error`);
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
      createMock.mockRejectedValue(new Error("db down"));

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

    const args = createMock.mock.calls[0][0] as { data: { metadata: { username?: string | null } } };
    expect(args.data.metadata.username).toBe("Org");
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

/**
 * `base`, with /me/accounts answered page by page as Graph pages it: a
 * `cursors.after` always, `next` only while there is another page. `fail`: the
 * page index answered 500.
 */
function withPagedAccounts(
  base: FakeProvider,
  pages: Array<Array<Record<string, unknown>>>,
  opts: { fail?: number } = {},
): FakeProvider {
  return (url) => {
    if (!url.includes("/me/accounts")) return base(url);
    const after = new URL(url).searchParams.get("after");
    const index = after ? Number(after.replace("cursor-", "")) : 0;
    if (index === opts.fail) return json({ error: { message: "An unexpected error has occurred." } }, 500);
    const cursor = `cursor-${index + 1}`;
    return json({
      data: pages[index] ?? [],
      paging: {
        cursors: { before: `cursor-${index}b`, after: cursor },
        ...(index + 1 < pages.length ? { next: `https://graph.facebook.com/v26.0/me/accounts?after=${cursor}` } : {}),
      },
    });
  };
}

/** A page as GET /rest/organizations/{id} answers it. */
type LinkedInPage = { id: number; localizedName?: string; vanityName?: string };

/**
 * organizationAcls lists `pages` (approved ADMINISTRATOR roles) and GET
 * /rest/organizations/{id} answers each of them; every other organization
 * call is refused. `acl` replaces the organizationAcls answer, `extra` answers
 * any other URL first (null: not handled).
 */
function linkedinProvider(
  pages: LinkedInPage[],
  opts: { acl?: () => Response; extra?: (url: string) => Response | null } = {},
): FakeProvider {
  return (url) => {
    if (url.includes("oauth/v2/accessToken")) {
      return json({ access_token: "li-access", expires_in: 3600, scope: "w_organization_social" });
    }
    if (url.includes("/rest/organizationAcls")) {
      if (opts.acl) return opts.acl();
      return json({
        elements: pages.map((page) => ({
          role: "ADMINISTRATOR",
          organization: `urn:li:organization:${page.id}`,
          roleAssignee: "urn:li:person:member-1",
          state: "APPROVED",
        })),
        paging: { count: 10, start: 0, links: [] },
      });
    }
    const extra = opts.extra?.(url);
    if (extra) return extra;
    const page = pages.find((p) => url === `https://api.linkedin.com/rest/organizations/${p.id}`);
    if (page) return json(page);
    if (url.includes("/organizations")) return json({ message: "Not enough permissions" }, 403);
    return new Response("not found", { status: 404 });
  };
}

/** A board as GET /v5/boards lists it. */
type PinterestBoardItem = { id: string; name: string; privacy?: string };

/**
 * The token exchange, GET /user_account and GET /boards. `pages` answers the
 * board list page by page (each page's bookmark leads to the next); without it
 * `boards` is the one page.
 */
function pinterestProvider(
  boards: PinterestBoardItem[],
  opts: { pages?: PinterestBoardItem[][]; account?: () => Response } = {},
): FakeProvider {
  const pages = opts.pages ?? [boards];
  return (url) => {
    if (url.includes("/v5/oauth/token")) {
      return json({
        access_token: "pin-access",
        refresh_token: "pin-refresh",
        expires_in: 2592000,
        refresh_token_expires_in: 5184000,
        scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
        token_type: "bearer",
      });
    }
    if (url.includes("/v5/user_account")) {
      return opts.account?.() ?? json({ id: "9001", username: "brand", account_type: "BUSINESS" });
    }
    if (url.includes("/v5/boards")) {
      const bookmark = new URL(url).searchParams.get("bookmark");
      const index = bookmark ? Number(bookmark.replace("page-", "")) : 0;
      return json({
        items: pages[index] ?? [],
        bookmark: index + 1 < pages.length ? `page-${index + 1}` : null,
      });
    }
    return new Response("not found", { status: 404 });
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
      expect(createMock).toHaveBeenCalledWith({
        data: { userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform: "facebook_page", ...fields },
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
      expect(createMock).not.toHaveBeenCalled();

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
      expect(createMock).toHaveBeenCalledWith({
        data: { userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform: "instagram", ...fields },
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
      expect(createMock).not.toHaveBeenCalled();
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

  // R32 platform-clients M1: /me/accounts gives 25 Pages a page by default; an
  // agency's client Page (or the one Page with Instagram) can be further on.
  describe("every page of /me/accounts is read", () => {
    const accountsCalls = () =>
      (fetchMock.mock.calls as Array<[string | URL]>).map((c) => String(c[0])).filter((u) => u.includes("/me/accounts"));

    it("facebook_page: a Page on the second page is offered too, read with the user token and the next cursor", async () => {
      useProvider(
        withPagedAccounts(facebookProvider([]), [
          [{ id: "page-1", name: "My Surf School", access_token: "page-token-1" }],
          [{ id: "page-27", name: "Client Cafe", access_token: "page-token-27" }],
        ]),
      );

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expectChooseRedirect(res);
      expect(createMock).not.toHaveBeenCalled();
      expect(createdPending().opened.pages).toEqual([
        { id: "page-1", name: "My Surf School", accessToken: "page-token-1" },
        { id: "page-27", name: "Client Cafe", accessToken: "page-token-27" },
      ]);
      const [first, second] = accountsCalls().map((u) => new URL(u));
      expect(accountsCalls()).toHaveLength(2);
      expect(first.searchParams.get("limit")).toBe("100");
      expect(first.searchParams.get("after")).toBeNull();
      expect(second.origin + second.pathname).toBe(first.origin + first.pathname);
      expect(second.searchParams.get("after")).toBe("cursor-1");
      expect(second.searchParams.get("access_token")).toBe("fb-user-token");
      expect(second.searchParams.get("fields")).toBe("id,name,access_token");
    });

    it("facebook_page: a second page that fails says the Pages couldn't be read, never that there are none", async () => {
      useProvider(
        withPagedAccounts(facebookProvider([]), [[{ id: "page-1", name: "Page", access_token: "page-token" }], []], { fail: 1 }),
      );

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expect(location(res).searchParams.get("error")).toBe("facebook_page_failed_to_fetch_pages");
      expectNoConnectionWrites();
    });

    it("facebook_page: a cursor Graph already sent ends the list, so no Page is added twice", async () => {
      useProvider((url) => {
        if (!url.includes("/me/accounts")) return facebookProvider([])(url);
        const after = new URL(url).searchParams.get("after");
        const page = after ? { id: "page-2", name: "Two", access_token: "t-2" } : { id: "page-1", name: "One", access_token: "t-1" };
        return json({
          data: [page],
          paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/v26.0/me/accounts?after=c1" },
        });
      });

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expectChooseRedirect(res);
      expect(accountsCalls()).toHaveLength(2);
      expect((createdPending().opened.pages as Array<{ id: string }>).map((p) => p.id)).toEqual(["page-1", "page-2"]);
    });

    it("facebook_page: a page that doesn't answer within 10 seconds is a failed read, never a short list", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(NOW);
      const paged = withPagedAccounts(facebookProvider([]), [[{ id: "page-1", name: "One", access_token: "t-1" }], []]);
      fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/me/accounts") || !new URL(url).searchParams.get("after")) return Promise.resolve(paged(url));
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });

      const pending = facebookPageGET(callbackRequest("facebook_page", signedState()));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(accountsCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(location(res).searchParams.get("error")).toBe("facebook_page_failed_to_fetch_pages");
      expectNoConnectionWrites();
    });

    it("facebook_page: the reading stops at 10 pages", async () => {
      useProvider(
        withPagedAccounts(
          facebookProvider([]),
          Array.from({ length: 12 }, (_, i) => [{ id: `page-${i + 1}`, name: `Page ${i + 1}`, access_token: `t-${i + 1}` }]),
        ),
      );

      const res = await facebookPageGET(callbackRequest("facebook_page", signedState()));

      expectChooseRedirect(res);
      expect(accountsCalls()).toHaveLength(10);
      expect((createdPending().opened.pages as unknown[]).length).toBe(10);
    });

    it("instagram: the one Page with an Instagram account on the second page connects", async () => {
      useProvider(
        withPagedAccounts(instagramProvider([], { "ig-27": "clientcafe" }), [
          [{ id: "page-1", name: "No IG", access_token: "page-token-1" }],
          [{ id: "page-27", name: "Client Cafe", access_token: "page-token-27", instagram_business_account: { id: "ig-27" } }],
        ]),
      );

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expect(location(res).searchParams.get("success")).toBe("instagram_connected");
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ platform: "instagram", accountIdentifier: "ig-27", accessToken: "page-token-27" }),
      });
    });

    // R32 lead follow-up: up to 1,000 Pages now, so the details are read a few at a time.
    it("instagram: each account's details are read at most 5 at a time, every one in the list's order", async () => {
      const pages = Array.from({ length: 12 }, (_, i) => ({
        id: `page-${i + 1}`,
        name: `Page ${i + 1}`,
        access_token: `t-${i + 1}`,
        instagram_business_account: { id: `ig-${i + 1}` },
      }));
      const base = withPagedAccounts(instagramProvider([], {}), [pages]);
      let inFlight = 0;
      let most = 0;
      fetchMock.mockImplementation(async (input: string | URL) => {
        const url = String(input);
        const ig = /\/(ig-\d+)\?/.exec(url)?.[1];
        if (!ig) return base(url);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return ig === "ig-7" ? json({ error: { message: "Unsupported get request" } }, 400) : json({ username: `user-${ig}` });
      });

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expectChooseRedirect(res);
      expect(most).toBe(5);
      const accounts = createdPending().opened.accounts as Array<{ igAccountId: string; username: string | null }>;
      expect(accounts.map((a) => a.igAccountId)).toEqual(pages.map((p) => p.instagram_business_account.id));
      // A failed read keeps today's handling: that row shows its Page name only.
      expect(accounts.map((a) => a.username)).toEqual(
        pages.map((p) => (p.instagram_business_account.id === "ig-7" ? null : `user-${p.instagram_business_account.id}`)),
      );
    });

    // R36 review low 3: 5 at a time at up to 15 s each, 100 or more accounts on
    // a slow Graph passed the 300 s function limit. The reads share one budget;
    // an account not read in time is listed by its Page name and read when chosen.
    it("instagram: a slow Graph with many accounts stops at the 60-second budget, lists every account, and an unread one can be chosen", async () => {
      expect(INSTAGRAM_DETAILS_BUDGET_MS).toBe(60_000);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(NOW);
      abortSignalTimeoutOnFakeClock();
      const pages = Array.from({ length: 100 }, (_, i) => ({
        id: `page-${i + 1}`,
        name: `Page ${i + 1}`,
        access_token: `t-${i + 1}`,
        instagram_business_account: { id: `ig-${i + 1}` },
      }));
      const base = withPagedAccounts(instagramProvider([], {}), [pages]);
      let slow = true;
      fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const ig = /\/(ig-\d+)\?/.exec(url)?.[1];
        if (!ig) return Promise.resolve(base(url));
        if (!slow) return Promise.resolve(json({ username: `user-${ig}` }));
        // Each read answers in 14 s, inside its own 15-second limit.
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(json({ username: `user-${ig}` })), 14_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        });
      });

      const pending = instagramGET(callbackRequest("instagram", signedState()));
      await vi.advanceTimersByTimeAsync(INSTAGRAM_DETAILS_BUDGET_MS);
      const res = await pending;

      expectChooseRedirect(res);
      const opened = createdPending().opened as unknown as PendingConnectionPayload & { platform: "instagram" };
      expect(opened.accounts.map((a) => a.igAccountId)).toEqual(pages.map((p) => p.instagram_business_account.id));
      // 4 rounds of 5 fit in 60 s; every account is listed, the rest by Page name only.
      expect(opened.accounts.filter((a) => a.username !== null)).toHaveLength(20);
      const unread = opened.accounts[99];
      expect(unread).toMatchObject({ igAccountId: "ig-100", pageName: "Page 100", username: null });

      // Chosen later, the unread account's details are read then, and it connects.
      slow = false;
      const chosen = await connectPendingCandidate({ id: "pending-1", platform: "instagram", payload: opened }, "ig-100", {
        userId: STATE_USER,
        workspaceId: STATE_WORKSPACE,
      });
      expect(chosen).toEqual({ ok: true });
      const created = createMock.mock.calls.at(-1)?.[0] as { data: { accountIdentifier: string; metadata: { username: string } } };
      expect(created.data.accountIdentifier).toBe("ig-100");
      expect(created.data.metadata.username).toBe("user-ig-100");
    });

    it("instagram: a second page that fails says the Pages couldn't be read, not that none has Instagram", async () => {
      useProvider(
        withPagedAccounts(instagramProvider([], {}), [[{ id: "page-1", name: "No IG", access_token: "page-token-1" }], []], {
          fail: 1,
        }),
      );

      const res = await instagramGET(callbackRequest("instagram", signedState()));

      expect(location(res).searchParams.get("error")).toBe("instagram_failed_to_fetch_pages");
      expectNoConnectionWrites();
    });
  });

  describe("linkedin", () => {
    it("one organization connects straight away, with the same upsert as before", async () => {
      useProvider(linkedinProvider([{ id: 101, localizedName: "Org" }]));

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
      // The fake token lasts an hour, inside the warning window: flagged (no name, no date).
      expect(location(res).searchParams.get("same_end")).toBe("1");
      expect(pendingCreateMock).not.toHaveBeenCalled();
      const fields = {
        accessToken: "li-access",
        refreshToken: null,
        expiresAt: new Date(NOW.getTime() + 3600 * 1000),
        scopes: "w_organization_social",
        // No member profile (no profile scope): the connection is named after the page.
        metadata: {
          name: "LinkedIn User",
          email: null,
          picture: null,
          organizations: [{ id: "101", name: "Org" }],
          username: "Org",
          organizationsFetchedAt: NOW.toISOString(),
        },
        ...HEALTHY,
      };
      expect(createMock).toHaveBeenCalledWith({
        data: {
          userId: STATE_USER,
          workspaceId: STATE_WORKSPACE,
          platform: "linkedin",
          ...fields,
          accountIdentifier: `linkedin_${NOW.getTime()}`,
        },
      });
    });

    // Unconfirmed (R7 client-journey): a fresh 60-day sign-in renews it; no flag.
    it("a token that lasts 60 days: connected, no same_end flag", async () => {
      const pages = linkedinProvider([{ id: 101, localizedName: "Org" }]);
      useProvider((url) =>
        url.includes("oauth/v2/accessToken")
          ? json({ access_token: "li-access", expires_in: 60 * 24 * 60 * 60, scope: "w_organization_social" })
          : pages(url),
      );

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
      expect(location(res).searchParams.has("same_end")).toBe(false);
    });

    it("several organizations connect none: the member token and the pages wait for the user's choice", async () => {
      useProvider(
        linkedinProvider([
          { id: 111, localizedName: "My Surf School", vanityName: "my-surf-school" },
          { id: 222, localizedName: "Client Cafe" },
        ]),
      );

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expectChooseRedirect(res);
      expect(createMock).not.toHaveBeenCalled();
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
        profile: { sub: `linkedin_${NOW.getTime()}`, name: "LinkedIn User", email: null, picture: null },
        organizations: [
          { id: "111", name: "My Surf School", vanityName: "my-surf-school" },
          { id: "222", name: "Client Cafe" },
        ],
      });
    });

    // 2026-11-09: the lookups moved from /v2/organizationalEntityAcls, /v2/organizations
    // and the sunset 202405 /rest call to the versioned organizationAcls and organizations APIs.
    describe("company-page lookups through the versioned REST APIs", () => {
      type Call = [string, RequestInit | undefined];
      const linkedinApiCalls = () =>
        (fetchMock.mock.calls as Call[]).filter(([url]) => String(url).startsWith("https://api.linkedin.com/"));
      const vanityState = (hint: string) => `${signedState()}.${Buffer.from(hint, "utf8").toString("base64url")}`;

      it("asks organizationAcls for approved ADMINISTRATOR roles, then the page by id, every /rest call versioned", async () => {
        useProvider(linkedinProvider([{ id: 101, localizedName: "Org" }]));

        await linkedinGET(callbackRequest("linkedin", signedState()));

        const urls = linkedinApiCalls().map(([url]) => String(url));
        expect(urls).toContain(
          "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start=0&count=10",
        );
        expect(urls).toContain("https://api.linkedin.com/rest/organizations/101");
        for (const [url, init] of linkedinApiCalls()) {
          if (!String(url).startsWith("https://api.linkedin.com/rest/")) continue;
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer li-access",
            "Linkedin-Version": "202610",
            "X-Restli-Protocol-Version": "2.0.0",
          });
        }
        const sent = JSON.stringify(fetchMock.mock.calls);
        expect(sent).not.toContain("202405");
        expect(sent).not.toContain("organizationalEntityAcls");
        expect(sent).not.toContain("/v2/organizations");
        expect(sent).not.toContain("ids=List(");
        // No legacy /v2 API at all: /v2/me needs a member profile scope the app
        // does not request (lib/oauthScopes.ts LINKEDIN_SCOPES), so it always failed.
        expect(linkedinApiCalls().map(([url]) => String(url)).filter((url) => url.includes("/v2/"))).toEqual([]);
      });

      it("organizationAcls refused: reuses the previous connection's page once GET /rest/organizations/{id} confirms it", async () => {
        findUniqueMock.mockResolvedValue({
          metadata: { organizations: [{ id: "555", name: "Old Name", vanityName: "old-name" }] },
        });
        useProvider(
          linkedinProvider([{ id: 555, localizedName: "New Name" }], {
            acl: () => json({ status: 403, message: "Not enough permissions" }, 403),
          }),
        );

        const res = await linkedinGET(callbackRequest("linkedin", signedState()));

        expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
        // The same page as the stored connection: updated in place.
        const args = updateManyMock.mock.calls[0][0] as { data: { metadata: { organizations: unknown[] } } };
        expect(args.data.metadata.organizations).toEqual([{ id: "555", name: "New Name", vanityName: "old-name" }]);
      });

      // 2026-11-09, live: an account that administers no page was "connected"
      // to a page it found by name, and every post was refused. When
      // organizationAcls answers, its list is the truth.
      it("an account that administers no page gets linkedin_no_admin_pages, even with a previous page or a hint", async () => {
        findUniqueMock.mockResolvedValue({ metadata: { organizations: [{ id: "555", name: "Old Name" }] } });
        useProvider(
          linkedinProvider([{ id: 555, localizedName: "Old Name" }, { id: 777, localizedName: "Hinted Page" }], {
            acl: () => json({ elements: [], paging: { count: 10, start: 0, links: [] } }),
          }),
        );

        for (const state of [signedState(), vanityState("777"), vanityState("acme-surf")]) {
          const res = await linkedinGET(callbackRequest("linkedin", state));
          expect(location(res).pathname).toBe("/settings");
          expect(location(res).searchParams.get("error")).toBe("linkedin_no_admin_pages");
        }
        expectNoConnectionWrites();
        const lookups = linkedinApiCalls().filter(([url]) => String(url).includes("/rest/organizations"));
        expect(lookups).toEqual([]);
      });

      it("the previous connection's page is not reused when LinkedIn no longer confirms it", async () => {
        findUniqueMock.mockResolvedValue({ metadata: { organizations: [{ id: "555", name: "Old Name" }] } });
        useProvider(linkedinProvider([], { acl: () => json({ status: 403, message: "Not enough permissions" }, 403) }));

        const res = await linkedinGET(callbackRequest("linkedin", signedState()));

        expect(location(res).searchParams.get("linkedin_setup")).toBe("true");
        expectNoConnectionWrites();
      });

      it("organizationAcls refused: a numeric id from the setup dialog is looked up with GET /rest/organizations/{id}", async () => {
        useProvider(
          linkedinProvider([{ id: 777, localizedName: "Hinted Page" }], {
            acl: () => json({ status: 403, message: "Not enough permissions" }, 403),
          }),
        );

        const res = await linkedinGET(callbackRequest("linkedin", vanityState("777")));

        expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
        const args = createMock.mock.calls[0][0] as { data: { metadata: { organizations: unknown[] } } };
        expect(args.data.metadata.organizations).toEqual([{ id: "777", name: "Hinted Page", vanityName: null }]);
      });

      it("organizationAcls refused: a vanity name from the setup dialog is looked up with GET /rest/organizations?q=vanityName", async () => {
        useProvider(
          linkedinProvider([], {
            acl: () => json({ status: 403, message: "Not enough permissions" }, 403),
            extra: (url) =>
              url === "https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=acme-surf"
                ? json({ elements: [{ id: 888, localizedName: "Acme Surf", vanityName: "acme-surf" }] })
                : null,
          }),
        );

        const res = await linkedinGET(callbackRequest("linkedin", vanityState("acme-surf")));

        expect(location(res).searchParams.get("success")).toBe("linkedin_connected");
        const args = createMock.mock.calls[0][0] as { data: { metadata: { organizations: unknown[]; username: string } } };
        expect(args.data.metadata.organizations).toEqual([{ id: "888", name: "Acme Surf", vanityName: "acme-surf" }]);
        expect(args.data.metadata.username).toBe("Acme Surf");
      });

      it("a page whose name LinkedIn will not give is still offered, by its id", async () => {
        useProvider(
          linkedinProvider([], {
            acl: () =>
              json({
                elements: [
                  { role: "ADMINISTRATOR", organization: "urn:li:organization:31", state: "APPROVED" },
                  { role: "ADMINISTRATOR", organization: "urn:li:organization:32", state: "APPROVED" },
                ],
              }),
          }),
        );

        const res = await linkedinGET(callbackRequest("linkedin", signedState()));

        expectChooseRedirect(res);
        expect(createdPending().opened.organizations).toEqual([{ id: "31" }, { id: "32" }]);
      });
    });

    it("no organizations found: LINKEDIN_ORGANIZATION_ID is no longer a fallback, the user is told the account administers no page", async () => {
      vi.stubEnv("LINKEDIN_ORGANIZATION_ID", "999");
      vi.stubEnv("LINKEDIN_ORGANIZATION_NAME", "Owner's Page");
      useProvider(linkedinProvider([]));

      const res = await linkedinGET(callbackRequest("linkedin", signedState()));

      expect(location(res).searchParams.get("error")).toBe("linkedin_no_admin_pages");
      expectNoConnectionWrites();
    });
  });

  // 2026-11-10: Pinterest. A Pin always goes on a board, so the "account" the
  // user chooses is the board.
  describe("pinterest", () => {
    const SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"];
    type Call = [string, RequestInit | undefined];
    const calls = () => fetchMock.mock.calls as Call[];

    it("an account with one board connects straight away, posting to that board", async () => {
      useProvider(pinterestProvider([{ id: "555", name: "Surf lessons", privacy: "PUBLIC" }]));

      const res = await pinterestGET(callbackRequest("pinterest", signedState()));

      expect(location(res).searchParams.get("success")).toBe("pinterest_connected");
      expect(pendingCreateMock).not.toHaveBeenCalled();
      const fields = {
        accessToken: "pin-access",
        refreshToken: "pin-refresh",
        expiresAt: new Date(NOW.getTime() + 2592000 * 1000),
        accountIdentifier: "brand",
        scopes: SCOPES,
        metadata: {
          username: "brand",
          accountId: "9001",
          accountType: "BUSINESS",
          boardId: "555",
          boardName: "Surf lessons",
        },
        ...HEALTHY,
      };
      expect(createMock).toHaveBeenCalledWith({
        data: { userId: STATE_USER, workspaceId: STATE_WORKSPACE, platform: "pinterest", ...fields },
      });
    });

    it("exchanges the code with HTTP Basic auth of the app id and secret, and reads the account and boards with the new token", async () => {
      useProvider(pinterestProvider([{ id: "555", name: "Surf lessons" }]));

      await pinterestGET(callbackRequest("pinterest", signedState()));

      const [tokenUrl, tokenInit] = calls()[0];
      expect(String(tokenUrl)).toBe("https://api.pinterest.com/v5/oauth/token");
      expect(tokenInit?.method).toBe("POST");
      expect((tokenInit?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("1234567:pin-secret").toString("base64")}`,
      );
      expect(Object.fromEntries(tokenInit?.body as URLSearchParams)).toEqual({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: `${ORIGIN}/api/auth/pinterest/callback`,
      });
      const apiCalls = calls().slice(1);
      expect(apiCalls.map(([url]) => String(url).split("?")[0]).sort()).toEqual([
        "https://api.pinterest.com/v5/boards",
        "https://api.pinterest.com/v5/user_account",
      ]);
      for (const [, init] of apiCalls) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pin-access");
      }
    });

    it("several boards connect none: the tokens and the boards wait for the user's choice", async () => {
      useProvider(
        pinterestProvider([
          { id: "555", name: "Surf lessons", privacy: "PUBLIC" },
          { id: "666", name: "Team photos", privacy: "SECRET" },
        ]),
      );

      const res = await pinterestGET(callbackRequest("pinterest", signedState()));

      expectChooseRedirect(res);
      expect(createMock).not.toHaveBeenCalled();
      const pending = createdPending();
      expect(pending.platform).toBe("pinterest");
      expect(pending.payload).not.toContain("pin-access");
      expect(pending.payload).not.toContain("pin-refresh");
      expect(pending.opened).toEqual({
        platform: "pinterest",
        token: {
          accessToken: "pin-access",
          refreshToken: "pin-refresh",
          expiresAt: new Date(NOW.getTime() + 2592000 * 1000).toISOString(),
          scopes: SCOPES,
        },
        account: { id: "9001", username: "brand", accountType: "BUSINESS" },
        boards: [
          { id: "555", name: "Surf lessons", privacy: "PUBLIC" },
          { id: "666", name: "Team photos", privacy: "SECRET" },
        ],
      });
    });

    it("reads every page of a long board list", async () => {
      useProvider(
        pinterestProvider([], {
          pages: [[{ id: "1", name: "One" }], [{ id: "2", name: "Two" }], [{ id: "3", name: "Three" }]],
        }),
      );

      await pinterestGET(callbackRequest("pinterest", signedState()));

      const boards = createdPending().opened.boards as Array<{ id: string }>;
      expect(boards.map((board) => board.id)).toEqual(["1", "2", "3"]);
    });

    it("an account with no boards is told to create one, and nothing is saved", async () => {
      useProvider(pinterestProvider([]));

      const res = await pinterestGET(callbackRequest("pinterest", signedState()));

      expect(location(res).searchParams.get("error")).toBe("pinterest_no_boards");
      expectNoConnectionWrites();
    });

    it("an account Pinterest won't describe is not connected", async () => {
      useProvider(
        pinterestProvider([{ id: "555", name: "Surf lessons" }], {
          account: () => json({ code: 2, message: "nope" }, 403),
        }),
      );

      const res = await pinterestGET(callbackRequest("pinterest", signedState()));

      expect(location(res).searchParams.get("error")).toBe("pinterest_account_unavailable");
      expectNoConnectionWrites();
    });

    it("a refused code exchange is pinterest_token_exchange_failed", async () => {
      useProvider((url) =>
        url.includes("/v5/oauth/token") ? json({ code: 283, message: "bad code" }, 400) : json({}, 404),
      );

      const res = await pinterestGET(callbackRequest("pinterest", signedState()));

      expect(location(res).searchParams.get("error")).toBe("pinterest_token_exchange_failed");
      expectNoConnectionWrites();
    });

    it("Pinterest's own ?error= (the user said no) is passed on as a cancellation", async () => {
      const url = new URL("/api/auth/pinterest/callback", ORIGIN);
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("state", signedState());

      const res = await pinterestGET(new NextRequest(url));

      expect(location(res).searchParams.get("error")).toBe("pinterest_access_denied");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// R6 review low 1: a reconnect only ever replaces the connection with the same
// platform account (server/connections/saveConnection.ts saveSocialConnection).
describe("a reconnect keeps the same account", () => {
  /** The stored connection for the account each fake provider signs in to, and one for another. */
  const STORED: Record<string, { same: Record<string, unknown>; other: Record<string, unknown>; signedInAs: string }> = {
    tiktok: {
      same: { accountIdentifier: "open-1", metadata: { username: "Surf TT" } },
      other: { accountIdentifier: "open-9", metadata: { username: "Surf TT" } },
      signedInAs: "a different TikTok account",
    },
    youtube: {
      same: { accountIdentifier: "My Channel", metadata: { channelId: "chan-1" } },
      other: { accountIdentifier: "Surf Channel", metadata: { channelId: "chan-9" } },
      signedInAs: "My Channel",
    },
    instagram: {
      same: { accountIdentifier: "ig-1", metadata: { username: "brand" } },
      other: { accountIdentifier: "ig-9", metadata: { username: "surfco" } },
      signedInAs: "@brand",
    },
    facebook_page: {
      same: { accountIdentifier: "page-1", metadata: { pageName: "Page" } },
      other: { accountIdentifier: "page-9", metadata: { pageName: "Surf Co" } },
      signedInAs: "Page",
    },
    linkedin: {
      same: { accountIdentifier: "member-1", metadata: { username: "Org", organizations: [{ id: "101" }] } },
      other: { accountIdentifier: "member-1", metadata: { username: "Surf Co page", organizations: [{ id: "999" }] } },
      signedInAs: "Org",
    },
    pinterest: {
      same: { accountIdentifier: "brand", metadata: { username: "brand" } },
      other: { accountIdentifier: "surfco", metadata: { username: "surfco" } },
      signedInAs: "brand",
    },
  };

  const accountCases = CASES.filter((c) => c.platform in STORED);

  it.each(accountCases)("$platform: the same account is replaced in place", async ({ platform, GET, provider }) => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    fetchMock.mockImplementation(async (input: string | URL) => provider(String(input)));
    findUniqueMock.mockResolvedValue({ platform, needsReconnect: true, ...STORED[platform].same });

    const res = await GET(callbackRequest(platform, signedState()));

    expect(location(res).searchParams.get("success")).toBe(`${platform}_connected`);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(accountCases)(
    "$platform: a different account leaves the connection unchanged and says which was signed in to",
    async ({ platform, GET, provider }) => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      fetchMock.mockImplementation(async (input: string | URL) => provider(String(input)));
      findUniqueMock.mockResolvedValue({ platform, needsReconnect: true, ...STORED[platform].other });

      const res = await GET(callbackRequest(platform, signedState()));

      const loc = location(res);
      expect(loc.pathname).toBe("/settings");
      expect(loc.searchParams.get("error")).toBe(`${platform}_different_account`);
      // R7-new-customer L2: no name in the address; Settings names the stored connection.
      expect(loc.searchParams.has("signed_in_as")).toBe(false);
      expect(loc.toString()).not.toContain(encodeURIComponent(STORED[platform].signedInAs).replace(/%20/g, "+"));
      expect(loc.searchParams.get("success")).toBeNull();
      expectNoConnectionWrites();
    },
  );

  // R6 second review 1: the token carries no account (only business.manage is
  // asked, no id_token); the chosen location, read with the NEW token, decides.
  const GBP_STORED = {
    id: "conn-gbp",
    platform: "google_business_profile",
    needsReconnect: true,
    accountIdentifier: "google_business_profile",
    metadata: { locationName: "accounts/1/locations/555", locationTitle: "Surf Co Dania" },
  };
  function gbpProvider(locationStatus: number) {
    return async (input: string | URL) =>
      String(input).includes("mybusinessbusinessinformation.googleapis.com/v1/locations/555")
        ? json(locationStatus === 200 ? { name: "locations/555" } : { error: {} }, locationStatus)
        : json({ access_token: "gbp-access", token_type: "Bearer" });
  }

  // R6 third review: never refused as another account; the location is cleared for the chooser.
  it.each([403, 404])(
    "google_business_profile: the new account can't use the chosen location (%i): saved, location cleared, chooser asked",
    async (code) => {
      getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
      fetchMock.mockImplementation(gbpProvider(code));
      findUniqueMock.mockResolvedValue(GBP_STORED);

      const loc = location(await gbpGET(callbackRequest("google_business_profile", signedState())));

      expect(loc.pathname).toBe("/settings");
      expect(loc.searchParams.get("success")).toBe("google_business_profile_connected");
      // R7-new-customer L2: a flag only, never the location's title.
      expect(loc.searchParams.get("location_cleared")).toBe("1");
      expect(loc.toString()).not.toContain("Surf");
      expect(loc.searchParams.get("error")).toBeNull();
      const update = updateManyMock.mock.calls[0][0] as { data: { metadata: Record<string, unknown> } };
      expect(update.data.metadata).toMatchObject({ locationName: null, locationTitle: null });
    },
  );

  it("google_business_profile: the location couldn't be read (500): unchanged, try again", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    fetchMock.mockImplementation(gbpProvider(500));
    findUniqueMock.mockResolvedValue(GBP_STORED);

    const loc = location(await gbpGET(callbackRequest("google_business_profile", signedState())));

    expect(loc.searchParams.get("error")).toBe("google_business_profile_account_check_failed");
    expectNoConnectionWrites();
  });

  it("google_business_profile: the new account reads the chosen location (200): updated in place, location kept", async () => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
    fetchMock.mockImplementation(gbpProvider(200));
    findUniqueMock.mockResolvedValue(GBP_STORED);

    const res = await gbpGET(callbackRequest("google_business_profile", signedState()));

    expect(location(res).searchParams.get("success")).toBe("google_business_profile_connected");
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const update = updateManyMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(update.where.id).toBe("conn-gbp");
    expect(update.data).not.toHaveProperty("metadata");
    // The token response has no id_token, and none is needed.
    expect(update.data.accountIdentifier).toBe("google_business_profile");
  });
});

// R27 platform-clients L3: a YouTube connect with "Manage your YouTube videos"
// unticked can't upload, so nothing is saved and Settings says to allow it.
describe("youtube OAuth callback: the upload permission", () => {
  const youtubeProvider = (scope: string | undefined) => (url: string) =>
    url.includes("youtube/v3/channels")
      ? json({ items: [{ id: "chan-1", snippet: { title: "My Channel" } }] })
      : json({ access_token: "yt-access", expires_in: 3600, token_type: "Bearer", ...(scope === undefined ? {} : { scope }) });

  beforeEach(() => {
    getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
  });

  it("granted without youtube.upload: saves nothing and redirects with youtube_upload_not_allowed", async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      youtubeProvider("https://www.googleapis.com/auth/youtube.readonly")(String(input)),
    );

    const res = await youtubeGET(callbackRequest("youtube", signedState()));

    const loc = location(res);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("youtube_upload_not_allowed");
    expect(loc.searchParams.get("success")).toBeNull();
    expectNoConnectionWrites();
  });

  // R28 platform-clients L3: "View your YouTube account" unticked; the channel
  // call would answer 403 and read as a generic failure.
  it("granted without youtube.readonly: saves nothing, no channel call, redirects with youtube_readonly_not_allowed", async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      youtubeProvider("https://www.googleapis.com/auth/youtube.upload")(String(input)),
    );

    const res = await youtubeGET(callbackRequest("youtube", signedState()));

    const loc = location(res);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("youtube_readonly_not_allowed");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("youtube/v3/channels"))).toBe(false);
    expectNoConnectionWrites();
  });

  it("granted with neither: the upload permission is named first", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => youtubeProvider("openid")(String(input)));

    const res = await youtubeGET(callbackRequest("youtube", signedState()));

    expect(location(res).searchParams.get("error")).toBe("youtube_upload_not_allowed");
    expectNoConnectionWrites();
  });

  it("granted with youtube.upload: connects as before and keeps the scopes", async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      youtubeProvider(
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      )(String(input)),
    );

    const res = await youtubeGET(callbackRequest("youtube", signedState()));

    expect(location(res).searchParams.get("success")).toBe("youtube_connected");
    const args = createMock.mock.calls[0][0] as { data: { scopes: string[] } };
    expect(args.data.scopes).toContain("https://www.googleapis.com/auth/youtube.upload");
  });
});

// R36 platform-clients L1: every call a callback makes while the person waits
// (the token exchange first) is bounded at 15 s, headers and body, so a stall
// is <platform>_connect_failed with its "try again", never Vercel's timeout
// page. TikTok's callback is frozen and keeps its own exchange.
describe("a provider that stalls during the callback", () => {
  const isTokenExchange = (url: string) =>
    url.includes("oauth2.googleapis.com/token") ||
    url.includes("oauth/v2/accessToken") ||
    url.includes("api.pinterest.com/v5/oauth/token") ||
    (url.includes("/oauth/access_token") && !url.includes("fb_exchange_token"));
  const STALL_POINTS: Array<{ platform: Platform; call: string; stalls: (url: string) => boolean; code?: string }> = [
    ...CASES.filter((c) => c.platform !== "tiktok").map((c) => ({
      platform: c.platform,
      call: "the token exchange",
      stalls: isTokenExchange,
    })),
    { platform: "facebook_page", call: "the long-lived token exchange", stalls: (url) => url.includes("fb_exchange_token") },
    { platform: "instagram", call: "the long-lived token exchange", stalls: (url) => url.includes("fb_exchange_token") },
    // Review low 2: the account read answers null, so this is its own failure code.
    {
      platform: "instagram",
      call: "the Instagram account read",
      stalls: (url) => url.includes("/ig-1"),
      code: "instagram_failed_to_fetch_ig_account",
    },
    { platform: "youtube", call: "the channel read", stalls: (url) => url.includes("youtube/v3/channels") },
  ];
  const stalls = [
    { kind: "no headers", fetch: headersNeverCome },
    { kind: "a body that never ends", fetch: bodyNeverEnds },
  ];

  for (const point of STALL_POINTS) {
    for (const stall of stalls) {
      const code = point.code ?? `${point.platform}_connect_failed`;
      it(`${point.platform}: ${point.call} with ${stall.kind} is ${code} after 15 seconds`, async () => {
        const { GET, provider } = CASES.find((c) => c.platform === point.platform)!;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abortSignalTimeoutOnFakeClock();
        getCurrentUserMock.mockResolvedValue({ id: STATE_USER });
        let stalled = 0;
        fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
          const url = String(input);
          if (point.stalls(url)) {
            stalled += 1;
            return stall.fetch(url, init);
          }
          return Promise.resolve(provider(url));
        });

        const pending = GET(callbackRequest(point.platform, signedState()));
        await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
        const res = await pending;

        expect(stalled).toBe(1);
        expect(location(res).searchParams.get("error")).toBe(code);
        expectNoConnectionWrites();
      });
    }
  }
});
