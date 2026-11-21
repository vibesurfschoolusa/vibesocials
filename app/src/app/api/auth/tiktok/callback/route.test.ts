import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R59 new-customer-2 L1: a TikTok reconnect whose user/info read gives no name
// must keep the stored account name. Only the save is checked here; every
// TikTok call is stubbed, so no test reaches open.tiktokapis.com.
// R60 platform-clients-2 L1: the real fetch helpers run over the stubbed
// global fetch, so a user/info body that never ends is bounded for real.
const { saveMock, userInfoMock, fetchMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  userInfoMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/server/connections/saveConnection", () => ({ saveSocialConnection: saveMock }));
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

import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { GET } from "./route";

const USER_INFO = "https://open.tiktokapis.com/v2/user/info/";

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
  userInfoMock.mockReset();
  fetchMock.mockReset().mockImplementation(async (input: string | URL, init?: RequestInit) => {
    if (String(input).startsWith(USER_INFO)) return userInfoMock(input, init);
    return new Response(
      JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 86400, open_id: "-000Ab", scope: "user.info.basic", token_type: "Bearer" }),
      { status: 200 },
    );
  });
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
    userInfoMock.mockResolvedValue(userInfo(null));

    await callback();

    expect(saveMock).toHaveBeenCalledTimes(1);
    const { update, create } = saveMock.mock.calls[0][0];
    expect(update).not.toHaveProperty("metadata");
    expect(update.accessToken).toBe("access");
    // A first connect still saves what it read.
    expect(create.metadata).toEqual({ username: null });
  });

  it("a reconnect with a name updates it", async () => {
    userInfoMock.mockResolvedValue(userInfo("Vibe Surf"));

    await callback();

    const { update, create } = saveMock.mock.calls[0][0];
    expect(update.metadata).toEqual({ username: "Vibe Surf" });
    expect(create.metadata).toEqual({ username: "Vibe Surf" });
  });

  it("a user/info failure is the same as no name", async () => {
    userInfoMock.mockRejectedValue(new Error("timed out"));

    await callback();

    expect(saveMock.mock.calls[0][0].update).not.toHaveProperty("metadata");
  });

  // R60 platform-clients-2 L1: headers that come with a body that never ends
  // are cut at 10 seconds; the name is null, so the stored name is kept.
  it("a user/info body that never ends is no name after 10 seconds, and the connection is saved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      abortSignalTimeoutOnFakeClock();
      userInfoMock.mockImplementation(bodyNeverEnds);

      const pending = callback();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0].update).not.toHaveProperty("metadata");
    expect(saveMock.mock.calls[0][0].create.metadata).toEqual({ username: null });
  }, 5_000);

  it("the user/info read asks with the access token, once", async () => {
    userInfoMock.mockResolvedValue(userInfo("Vibe Surf"));

    await callback();

    expect(userInfoMock).toHaveBeenCalledTimes(1);
    const [, init] = userInfoMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
