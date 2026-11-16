import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// api/settings/route.test.ts). route.ts imports `@/lib/db` (a real
// `new PrismaClient()` requiring DATABASE_URL), `@/lib/workspace` and
// `@/server/googleReviews` at module scope, so all three must be mocked
// before route.ts is imported below.
const { findFirstMock, updateMock, getWorkspaceContextMock, refreshAccessTokenMock } = vi.hoisted(
  () => ({
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    getWorkspaceContextMock: vi.fn(),
    refreshAccessTokenMock: vi.fn(),
  })
);

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
  expiresAt: null,
};

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceContextMock.mockResolvedValue(CONTEXT);
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

  // F7 (R1 M5): what the page shows is a plain sentence, with a reconnect step
  // when Google refused.
  it.each([401, 403])("asks for a reconnect when Google answers %i", async (status) => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: "Refused",
      text: async () => "{}",
    }) as unknown as typeof fetch;

    const body = await (await GET()).json();

    expect(body).toEqual({
      error: "Google refused the request. Reconnect Google Business Profile in Settings.",
      reconnect: true,
    });
  });

  // R12 L1: a member reads who can reconnect, and the page gets no Settings link.
  it("a member: who can reconnect when Google refuses", async () => {
    getWorkspaceContextMock.mockResolvedValue({ ...CONTEXT, role: "member" });
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Refused",
      text: async () => "{}",
    }) as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({
      error: "Google refused the request. The workspace owner can reconnect Google Business Profile.",
    });
  });

  it("gives a plain sentence when Google is down", async () => {
    findFirstMock.mockResolvedValue(CONNECTION);
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "upstream down",
    }) as unknown as typeof fetch;

    const body = await (await GET()).json();

    expect(body).toEqual({ error: "Couldn't load your Google locations. Try again in a minute." });
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

  it("a refresh Google refuses keeps today's reconnect text", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expiringIn(4 * MINUTE);
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
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
