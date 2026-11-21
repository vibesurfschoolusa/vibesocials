import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R59 new-customer-2 L1: a TikTok reconnect whose user/info read gives no name
// must keep the stored account name. Only the save is checked here; every
// TikTok call is stubbed, so no test reaches open.tiktokapis.com.
const { saveMock, fetchWithTimeoutMock, fetchMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/server/connections/saveConnection", () => ({ saveSocialConnection: saveMock }));
vi.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: fetchWithTimeoutMock }));
vi.mock("@/lib/oauthState", () => ({
  verifyOAuthState: () => ({ valid: true, userId: "user-1", workspaceId: "ws-1" }),
}));
vi.mock("@/lib/oauthCallbackGuard", () => ({
  guardOAuthCallbackSession: async () => null,
  oauthCallbackFailed: () => new Response(null, { status: 500 }),
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: async () => true }));
vi.mock("@/server/connectLink/callback", () => ({
  withConnectLink: (_platform: string, handler: (request: Request, link: null) => Promise<Response>) =>
    (request: Request) => handler(request, null),
}));

import { GET } from "./route";

const callback = () =>
  (GET as unknown as (request: Request) => Promise<Response>)(
    new Request("https://app.example.com/api/auth/tiktok/callback?code=the-code&state=the-state"),
  );

function userInfo(displayName: string | null): Response {
  return new Response(JSON.stringify({ data: { user: displayName ? { display_name: displayName } : {} } }), {
    status: 200,
  });
}

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue({ ok: true });
  fetchWithTimeoutMock.mockReset();
  fetchMock.mockReset().mockResolvedValue(
    new Response(
      JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 86400, open_id: "-000Ab", scope: "user.info.basic", token_type: "Bearer" }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TIKTOK_CLIENT_KEY", "test-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "test-secret");
  vi.stubEnv("TIKTOK_REDIRECT_URI", "https://app.example.com/api/auth/tiktok/callback");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TikTok callback: the account name on reconnect", () => {
  it("a reconnect with no name keeps the stored name: the update leaves metadata alone", async () => {
    fetchWithTimeoutMock.mockResolvedValue(userInfo(null));

    await callback();

    expect(saveMock).toHaveBeenCalledTimes(1);
    const { update, create } = saveMock.mock.calls[0][0];
    expect(update).not.toHaveProperty("metadata");
    expect(update.accessToken).toBe("access");
    // A first connect still saves what it read.
    expect(create.metadata).toEqual({ username: null });
  });

  it("a reconnect with a name updates it", async () => {
    fetchWithTimeoutMock.mockResolvedValue(userInfo("Vibe Surf"));

    await callback();

    const { update, create } = saveMock.mock.calls[0][0];
    expect(update.metadata).toEqual({ username: "Vibe Surf" });
    expect(create.metadata).toEqual({ username: "Vibe Surf" });
  });

  it("a user/info failure is the same as no name", async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error("timed out"));

    await callback();

    expect(saveMock.mock.calls[0][0].update).not.toHaveProperty("metadata");
  });
});
