import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, loggerWarnMock, loggerErrorMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));

import {
  OAUTH_SESSION_MISMATCH,
  guardOAuthCallbackSession,
  oauthCallbackFailed,
} from "./oauthCallbackGuard";

const BASE = "https://app.example.com/api/auth/tiktok/callback?code=c&state=s";

function location(res: Response): URL {
  const raw = res.headers.get("location");
  expect(raw).toBeTruthy();
  return new URL(raw as string);
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  loggerWarnMock.mockReset();
  loggerErrorMock.mockReset();
});

describe("guardOAuthCallbackSession", () => {
  it("redirects to /login?callbackUrl=%2Fsettings when there is no session", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await guardOAuthCallbackSession({
      platform: "tiktok",
      stateUserId: "user-a",
      baseUrl: BASE,
    });

    expect(res).not.toBeNull();
    expect(res!.status).toBe(307);
    expect(res!.headers.get("location")).toBe(
      "https://app.example.com/login?callbackUrl=%2Fsettings",
    );
  });

  it("redirects to /settings?error=oauth_session_mismatch when the signed-in user is not the state user", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-b" });

    const res = await guardOAuthCallbackSession({
      platform: "youtube",
      stateUserId: "user-a",
      baseUrl: BASE,
    });

    expect(res).not.toBeNull();
    expect(OAUTH_SESSION_MISMATCH).toBe("oauth_session_mismatch");
    const loc = location(res!);
    expect(loc.origin).toBe("https://app.example.com");
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("oauth_session_mismatch");
    // A mismatch is a possible connection-CSRF attempt: logged (ids only).
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock.mock.calls[0][1]).toEqual({
      platform: "youtube",
      stateUserId: "user-a",
      sessionUserId: "user-b",
    });
  });

  it("returns null (proceed) when the signed-in user is the state user", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-a" });

    const res = await guardOAuthCallbackSession({
      platform: "x",
      stateUserId: "user-a",
      baseUrl: BASE,
    });

    expect(res).toBeNull();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("propagates a session-lookup failure so the caller's catch can map it to <platform>_connect_failed", async () => {
    getCurrentUserMock.mockRejectedValue(new Error("db down"));

    await expect(
      guardOAuthCallbackSession({ platform: "linkedin", stateUserId: "user-a", baseUrl: BASE }),
    ).rejects.toThrow("db down");
  });

  it("accepts a bare origin as the base URL (LinkedIn/X use NEXTAUTH_URL)", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await guardOAuthCallbackSession({
      platform: "linkedin",
      stateUserId: "user-a",
      baseUrl: "https://app.example.com",
    });

    expect(res!.headers.get("location")).toBe(
      "https://app.example.com/login?callbackUrl=%2Fsettings",
    );
  });
});

describe("oauthCallbackFailed", () => {
  it("redirects to /settings?error=<platform>_connect_failed", () => {
    const res = oauthCallbackFailed({
      platform: "google_business_profile",
      baseUrl: BASE,
      error: new Error("boom"),
    });

    expect(res.status).toBe(307);
    const loc = location(res);
    expect(loc.pathname).toBe("/settings");
    expect(loc.searchParams.get("error")).toBe("google_business_profile_connect_failed");
  });

  it("logs the error through the logger with the platform", () => {
    const error = new TypeError("fetch failed");
    oauthCallbackFailed({ platform: "facebook_page", baseUrl: BASE, error });

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock.mock.calls[0][1]).toEqual({ platform: "facebook_page", error });
  });

  it("never logs the provider body a JSON parse error quotes (it can hold tokens)", () => {
    // V8's JSON.parse messages (and so `stack`) quote a window of the
    // unparseable input, e.g. `Unexpected token 'E', ..."ss_token":EAAB-secre"...`.
    let error: unknown;
    try {
      JSON.parse('{"access_token":EAAB-secret-token-value}');
    } catch (caught) {
      error = caught;
    }
    expect(String((error as Error).message)).toContain("EAAB-secre");

    const res = oauthCallbackFailed({ platform: "instagram", baseUrl: BASE, error });

    expect(new URL(res.headers.get("location") as string).searchParams.get("error")).toBe(
      "instagram_connect_failed",
    );
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const logged = loggerErrorMock.mock.calls[0];
    // Serialize Errors the way the logger does (name/message/stack).
    const serialized = JSON.stringify(logged, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    );
    expect(serialized).not.toContain("EAAB");
    expect(logged[1]).toEqual({
      platform: "instagram",
      error: { name: "SyntaxError", message: "Provider response was not valid JSON" },
    });
  });
});
