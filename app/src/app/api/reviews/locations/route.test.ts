import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// api/settings/route.test.ts). route.ts imports `@/lib/db` (a real
// `new PrismaClient()` requiring DATABASE_URL), `@/lib/workspace` and
// `@/server/googleReviews` at module scope, so all three must be mocked
// before route.ts is imported below.
const { findFirstMock, updateMock, getWorkspaceContextMock, refreshAccessTokenMock, checkRateLimitMock, flagRejectedTokenMock } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    getWorkspaceContextMock: vi.fn(),
    refreshAccessTokenMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    flagRejectedTokenMock: vi.fn(),
  }));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/server/platforms/connectionHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionHealth")>()),
  flagRejectedToken: flagRejectedTokenMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findFirst: findFirstMock, update: updateMock },
  },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock("@/server/googleReviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/googleReviews")>()),
  refreshAccessToken: refreshAccessTokenMock,
}));

import { GET } from "./route";

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme" },
  role: "owner" as const,
  memberCount: 1,
};

const CONNECTION = {
  id: "conn-1",
  workspaceId: "ws-1",
  platform: "google_business_profile",
  accessToken: "token-abc",
  refreshToken: "refresh-abc",
  expiresAt: null,
};

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceContextMock.mockResolvedValue(CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  flagRejectedTokenMock.mockResolvedValue("flagged");
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/reviews/locations", () => {
  it("returns 401 when there is no workspace context", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });

  // The reviews page renders a red "Couldn't load reviews" ErrorState for any
  // non-ok response. Having no Google Business Profile connection is the normal
  // state for every new user, not a failure — so it must come back 200 with an
  // explicit `connected: false`, which the client turns into the "Connect
  // Google Business Profile" empty state.
  it("returns 200 with connected:false when the workspace has no GBP connection", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ locations: [], connected: false });
    expect(body.error).toBeUndefined();
  });

  it("reports connected:true with no locations when Google returns no accounts", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accounts: [] }),
    }) as unknown as typeof fetch;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ locations: [], connected: true });
  });

  it("reports connected:true alongside the locations it found", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/accounts") && !String(url).includes("/locations")) {
        return Promise.resolve({ ok: true, json: async () => ({ accounts: [{ name: "accounts/1" }] }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          locations: [{ name: "locations/9", title: "Main Street", storeCode: "MS" }],
        }),
      });
    }) as unknown as typeof fetch;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.locations).toHaveLength(1);
    // Bare "locations/..." names are expanded to the full resource path.
    expect(body.locations[0].name).toBe("accounts/1/locations/9");
    expect(body.locations[0].title).toBe("Main Street");
  });

  // A genuine upstream failure must still surface as an error so the page keeps
  // showing the red ErrorState with a Retry that can actually help.
  it("still returns 500 when the Google accounts call fails", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "upstream down",
    }) as unknown as typeof fetch;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBeTruthy();
  });

  // R25 platform-clients L2: an API 401 flags the row (the token that call
  // sent), so the card shows Reconnect; the owner keeps the in-place sign-in.
  it("a 401 flags the row and reads Reconnect, with the in-place sign-in", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const body = await (await GET()).json();

    expect(body).toEqual({
      error: "Google refused the request. Reconnect Google Business Profile in Settings.",
      reconnect: true,
      signIn: true,
    });
    expect(flagRejectedTokenMock).toHaveBeenCalledWith(
      { id: "conn-1", accessToken: "token-abc", refreshToken: "refresh-abc" },
      "GOOGLE_API_TOKEN_REJECTED",
    );
  });

  // R25 client-journey L1: the in-place sign-in keeps the row, its numbers and the location.
  it("a 403 offers the in-place sign-in with the account that manages the business", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 403 })) as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({
      error:
        "Google refused access to this Business Profile account: the connected Google account may no longer manage your business. Sign in to Google again with the account that manages your business.",
      reconnect: true,
      signIn: true,
    });
    expect(flagRejectedTokenMock).not.toHaveBeenCalled();
  });

  // R12 L1: a member reads who can reconnect, and the page gets no Settings link.
  it("a member: who can reconnect when Google refuses the token", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...CONTEXT, role: "member" });
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 })) as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({
      error: "Google refused the request. The workspace owner can reconnect Google Business Profile.",
    });
  });

  // JJ3 lead review: a 5xx is "try later" on every Google surface.
  it("says to try later when Google is down", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "upstream down",
    }) as unknown as typeof fetch;

    const body = await (await GET()).json();

    expect(body).toEqual({ error: "Google Business Profile isn't answering for Vibe Socials right now. Try again later." });
  });
});

// R23 client-journey L1: a Google token in its last 5 minutes is refreshed
// first (googleTokenExpiresSoon), so the account listing never runs past expiry.
describe("GET /api/reviews/locations and a token about to expire", () => {
  const MINUTE = 60 * 1000;
  const noAccounts = () =>
    (global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accounts: [] }),
    }) as unknown as typeof fetch);
  const expiringIn = (ms: number) =>
    findFirstMock.mockResolvedValue({ ...CONNECTION, expiresAt: new Date(Date.now() + ms) });

  it("refreshes a token with 4 minutes left before asking Google", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expiringIn(4 * MINUTE);
    refreshAccessTokenMock.mockResolvedValue({ ...CONNECTION, accessToken: "fresh", expiresAt: new Date() });
    noAccounts();

    const response = await GET();

    expect(response.status).toBe(200);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fresh");
  });

  it("leaves a token with 10 minutes left alone", async () => {
    expiringIn(10 * MINUTE);
    noAccounts();

    await GET();

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-abc");
  });

  it("a failed refresh with 4 minutes left serves the request with the stored token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expiringIn(4 * MINUTE);
    refreshAccessTokenMock.mockRejectedValue(
      Object.assign(new Error("Failed to refresh Google access token (status 503)"), {
        code: "GOOGLE_TOKEN_REFRESH_FAILED",
        status: 503,
      }),
    );
    noAccounts();

    const response = await GET();

    expect(response.status).toBe(200);
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-abc");
  });

  it("a refresh Google refuses after expiry keeps today's reconnect text", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expiringIn(-MINUTE);
    refreshAccessTokenMock.mockRejectedValue(
      Object.assign(new Error("Failed to refresh Google access token (status 400)"), {
        code: "GOOGLE_TOKEN_REFRESH_FAILED",
        status: 400,
        oauthError: "invalid_grant",
      }),
    );
    noAccounts();

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Google refused the request. Reconnect Google Business Profile in Settings.",
      reconnect: true,
      signIn: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// Lead review (R23): a connection Google has revoked (flagged needsReconnect)
// gets the reconnect text at once, as the link route does, and Google is not asked.
describe("GET /api/reviews/locations for a connection flagged for reconnect", () => {
  it("answers with the reconnect text and asks Google nothing", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    findFirstMock.mockResolvedValue({ ...CONNECTION, expiresAt: new Date(Date.now() + 4 * 60 * 1000), needsReconnect: true });

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Google refused the request. Reconnect Google Business Profile in Settings.",
      reconnect: true,
      signIn: true,
    });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
type Page = { status?: number; body?: Record<string, unknown> };

/** Google, as a map from "<path>|<pageToken or ''>" to the page it answers. */
function google(pages: Record<string, Page>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const page = pages[`${url.origin}${url.pathname}|${url.searchParams.get("pageToken") ?? ""}`];
    if (!page) throw new Error(`unexpected request ${url.toString()}`);
    return Response.json(page.body ?? {}, { status: page.status ?? 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const shop = (id: number) => ({ name: `locations/${id}`, title: `Shop ${id}` });

// R25 client-journey M1: the Reviews list is the same paged listing as the
// Settings picker: every page of accounts and of locations, 100 a page.
describe("GET /api/reviews/locations lists every page", () => {
  function twoPagesEach() {
    return google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }], nextPageToken: "a2" } },
      [`${ACCOUNTS}|a2`]: { body: { accounts: [{ name: "accounts/2" }] } },
      [`${INFO}/accounts/1/locations|`]: { body: { locations: [shop(1)] } },
      [`${INFO}/accounts/2/locations|`]: { body: { locations: [shop(2)], nextPageToken: "l2" } },
      [`${INFO}/accounts/2/locations|l2`]: { body: { locations: [shop(3)] } },
    });
  }

  it("two pages of accounts and two of locations: all listed, 100 locations a page", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    const fetchMock = twoPagesEach();

    const body = await (await GET()).json();

    expect(body).toEqual({
      connected: true,
      locations: [
        { name: "accounts/1/locations/1", locationName: "Shop 1", title: "Shop 1" },
        { name: "accounts/2/locations/2", locationName: "Shop 2", title: "Shop 2" },
        { name: "accounts/2/locations/3", locationName: "Shop 3", title: "Shop 3" },
      ],
    });
    const locationCalls = fetchMock.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter((u) => u.pathname.endsWith("/locations"));
    expect(locationCalls.map((u) => u.searchParams.get("pageSize"))).toEqual(["100", "100", "100"]);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  // R25 client-journey L3: a member sees only the workspace's saved location.
  it("a member sees only the saved location, found on the second page", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...CONTEXT, role: "member" });
    findFirstMock.mockResolvedValue({ ...CONNECTION, metadata: { locationName: "accounts/2/locations/3" } });
    twoPagesEach();

    const body = await (await GET()).json();

    expect(body).toEqual({
      connected: true,
      locations: [{ name: "accounts/2/locations/3", locationName: "Shop 3", title: "Shop 3" }],
    });
  });

  it("the owner sees every location, whatever is saved", async () => {
    findFirstMock.mockResolvedValue({ ...CONNECTION, metadata: { locationName: "accounts/2/locations/3" } });
    twoPagesEach();

    expect((await (await GET()).json()).locations).toHaveLength(3);
  });

  it("a member with no saved location sees none, and is told who chooses it", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...CONTEXT, role: "member" });
    findFirstMock.mockResolvedValue(CONNECTION);
    twoPagesEach();

    const body = await (await GET()).json();

    expect(body.locations).toEqual([]);
    expect(body.notice).toBe(
      "The workspace owner hasn't chosen this workspace's Google location yet. Its reviews show here once they have.",
    );
  });
});

// R25 platform-clients L1 / new-customer L4: an account whose locations could
// not be read is said, never "doesn't have any locations yet".
describe("GET /api/reviews/locations when accounts could not be read", () => {
  it("one account of two failing: the rest are listed, with the notice", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] } },
      [`${INFO}/accounts/1/locations|`]: { status: 503 },
      [`${INFO}/accounts/2/locations|`]: { body: { locations: [shop(2)] } },
    });

    const body = await (await GET()).json();

    expect(body.locations).toHaveLength(1);
    expect(body.notice).toBe(
      "Google didn't send the locations of some of your Business Profile accounts. Reload this page in a minute to see them all.",
    );
  });

  it("the only account failing: the whole-list error, not an empty list", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: { status: 503 },
    });

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Google Business Profile isn't answering for Vibe Socials right now. Try again later.",
    });
  });

  it("the only account refusing access: the access answer, with the in-place sign-in", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: { status: 403 },
    });

    const body = await (await GET()).json();

    expect(body).toMatchObject({ reconnect: true, signIn: true });
    expect(body.error).toMatch(/^Google refused access to this Business Profile account/);
  });
});

// R25 security-billing L1: Google counts quota per project, so each person is limited.
describe("GET /api/reviews/locations rate limit", () => {
  it("over the limit: 429, and Google is not asked", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    global.fetch = vi.fn() as unknown as typeof fetch;

    const response = await GET();

    expect(response.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith({ userId: "user-1", route: "reviews/locations", limit: 60, windowMs: 300_000 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
