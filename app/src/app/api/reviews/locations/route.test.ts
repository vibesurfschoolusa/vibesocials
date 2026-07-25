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

vi.mock("@/server/googleReviews", () => ({
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
});
