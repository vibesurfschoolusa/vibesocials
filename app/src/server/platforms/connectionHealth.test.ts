import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_TOKEN_CHANGED_CODE,
  TOKEN_REFRESH_SUPERSEDED_CODE,
  connectionTokenChangedError,
  flagRejectedToken,
  isTerminalRefreshFailure,
  markConnectionNeedsReconnect,
  readOAuthErrorCode,
  tokenRefreshSupersededError,
} from "@/server/platforms/connectionHealth";

// Mirrors googleTokens.test.ts: vi.mock + vi.hoisted are hoisted above
// imports, and markConnectionNeedsReconnect resolves prisma via
// `await import("@/lib/db")` at call time, so it receives this mock. No real
// database is touched.
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
      findUnique: findUniqueMock,
    },
  },
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  findUniqueMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markConnectionNeedsReconnect", () => {
  it("updates by id with ONLY needsReconnect/lastRefreshErrorCode/refreshFailedAt — never tokens", async () => {
    const before = Date.now();
    await markConnectionNeedsReconnect("conn-123", "GOOGLE_TOKEN_REFRESH_FAILED");
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };

    expect(arg.where).toEqual({ id: "conn-123" });

    // THE program-level constraint: update data contains ONLY these three keys.
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");

    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("GOOGLE_TOKEN_REFRESH_FAILED");

    const refreshFailedAt = arg.data.refreshFailedAt as Date;
    expect(refreshFailedAt instanceof Date && !isNaN(refreshFailedAt.getTime())).toBe(true);
    expect(refreshFailedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(refreshFailedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("passes through the given code verbatim for a different platform's reconnect code", async () => {
    await markConnectionNeedsReconnect("conn-456", "LINKEDIN_RECONNECT_REQUIRED");

    const arg = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
  });

  it("swallows a database failure (logs, does not throw) so it never masks the caller's original error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      markConnectionNeedsReconnect("conn-789", "INSTAGRAM_RECONNECT_REQUIRED"),
    ).resolves.toBe("error");

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("without `expected` it never re-reads the row and reports 'flagged'", async () => {
    await expect(markConnectionNeedsReconnect("conn-1", "X")).resolves.toBe("flagged");

    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-01 scale audit (jobs, token refresh): a refresher that lost a race
// (TikTok rotates the refresh token, so the loser gets invalid_grant) must not
// flag a connection another process just refreshed. The guarded flag re-reads
// the stored tokens and writes nothing unless they still equal the ones the
// failed refresh used.
describe("markConnectionNeedsReconnect — guarded by `expected` tokens", () => {
  const expected = { accessToken: "access-1", refreshToken: "refresh-1" };

  it("writes nothing and reports 'superseded' when the stored tokens differ from `expected`", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-2", refreshToken: "refresh-2" });

    const result = await markConnectionNeedsReconnect("conn-1", "TIKTOK_RECONNECT_REQUIRED", {
      expected,
    });

    expect(result).toBe("superseded");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ["only the access token changed (Google, LinkedIn)", { accessToken: "access-2", refreshToken: "refresh-1" }],
    ["only the refresh token rotated (TikTok)", { accessToken: "access-1", refreshToken: "refresh-2" }],
    ["the refresh token was cleared", { accessToken: "access-1", refreshToken: null }],
  ])("is superseded when %s", async (_label, stored) => {
    findUniqueMock.mockResolvedValue(stored);

    await expect(
      markConnectionNeedsReconnect("conn-1", "X", { expected }),
    ).resolves.toBe("superseded");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("writes the three flag fields and reports 'flagged' when the stored tokens equal `expected`", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-1", refreshToken: "refresh-1" });

    const result = await markConnectionNeedsReconnect("conn-1", "TIKTOK_RECONNECT_REQUIRED", {
      expected,
    });

    expect(result).toBe("flagged");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "conn-1" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("TIKTOK_RECONNECT_REQUIRED");
  });

  it("treats a null refresh token on both sides as equal", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-1", refreshToken: null });

    await expect(
      markConnectionNeedsReconnect("conn-1", "X", {
        expected: { accessToken: "access-1", refreshToken: null },
      }),
    ).resolves.toBe("flagged");
  });

  it("reads only the two token columns, through the extended client, by id", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-1", refreshToken: "refresh-1" });

    await markConnectionNeedsReconnect("conn-1", "X", { expected });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      select: { accessToken: true, refreshToken: true },
    });
  });

  it("reports 'superseded' (and writes nothing) when the row is gone", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(
      markConnectionNeedsReconnect("conn-1", "X", { expected }),
    ).resolves.toBe("superseded");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("swallows a failed re-read: reports 'error', writes nothing, never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUniqueMock.mockRejectedValue(new Error("connection refused"));

    await expect(
      markConnectionNeedsReconnect("conn-1", "X", { expected }),
    ).resolves.toBe("error");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("tokenRefreshSupersededError", () => {
  it("carries the TOKEN_REFRESH_SUPERSEDED code and a fixed, token-free message", () => {
    const error = tokenRefreshSupersededError();

    expect(TOKEN_REFRESH_SUPERSEDED_CODE).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(error.message).not.toMatch(/token.*[A-Za-z0-9]{20,}/);
  });
});

// 2026-11-02 scale audit (jobs, token refresh): an ordinary API call that the
// platform answered with a 401 flags the connection only when the stored tokens
// are still the ones that call used. Another process may have rotated them, or
// the user may have reconnected, between our read of the row and the call.
describe("flagRejectedToken", () => {
  const snapshot = { id: "conn-1", accessToken: "access-1", refreshToken: "refresh-1" };

  it("writes the three flag fields and reports 'flagged' when the stored tokens still match", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-1", refreshToken: "refresh-1" });

    await expect(flagRejectedToken(snapshot, "TIKTOK_RECONNECT_REQUIRED")).resolves.toBe("flagged");

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-1" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("TIKTOK_RECONNECT_REQUIRED");
  });

  it("writes nothing and reports 'superseded' when the stored tokens differ", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "rotated", refreshToken: "refresh-1" });

    await expect(flagRejectedToken(snapshot, "TIKTOK_RECONNECT_REQUIRED")).resolves.toBe("superseded");

    expect(updateMock).not.toHaveBeenCalled();
  });

  it("compares a null refresh token too (Instagram, Facebook Page)", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "access-1", refreshToken: null });

    await expect(
      flagRejectedToken({ id: "conn-1", accessToken: "access-1", refreshToken: null }, "X"),
    ).resolves.toBe("flagged");
    await expect(
      flagRejectedToken({ id: "conn-1", accessToken: "access-1", refreshToken: "refresh-1" }, "X"),
    ).resolves.toBe("superseded");
  });

  it("reports 'error' when the re-read fails, and writes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUniqueMock.mockRejectedValue(new Error("connection refused"));

    await expect(flagRejectedToken(snapshot, "X")).resolves.toBe("error");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("connectionTokenChangedError", () => {
  it("carries the CONNECTION_TOKEN_CHANGED code and a fixed, token-free retry message", () => {
    const error = connectionTokenChangedError();

    expect(CONNECTION_TOKEN_CHANGED_CODE).toBe("CONNECTION_TOKEN_CHANGED");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("CONNECTION_TOKEN_CHANGED");
    expect(error.message).toBe(
      "This connection was refreshed or reconnected while publishing. Please retry.",
    );
  });
});

// 2026-11-01 audit (Task 4 item 2): ONE classification for every OAuth
// refresh (Google, LinkedIn, TikTok). Only a terminal failure — the grant is
// dead — may flag needsReconnect; anything that a later attempt could succeed
// at must leave the connection alone.
describe("isTerminalRefreshFailure", () => {
  it.each([
    ["400 invalid_grant", 400, "invalid_grant", true],
    ["400 with no parseable OAuth error", 400, undefined, true],
    ["401 invalid_token", 401, "invalid_token", true],
    ["200 carrying invalid_grant (TikTok error-in-body)", 200, "invalid_grant", true],
    ["403 invalid_grant (non-5xx, grant is dead)", 403, "invalid_grant", true],
    ["429 rate limited", 429, undefined, false],
    ["429 even with invalid_grant in the body", 429, "invalid_grant", false],
    ["500", 500, undefined, false],
    ["502 even with invalid_grant in the body", 502, "invalid_grant", false],
    ["503", 503, undefined, false],
    ["401 invalid_client (our client credentials, not the user's grant)", 401, "invalid_client", false],
    ["400 invalid_client", 400, "invalid_client", false],
    ["403 with no OAuth error", 403, undefined, false],
    ["404", 404, undefined, false],
  ] as const)("%s", (_label, status, oauthError, terminal) => {
    expect(isTerminalRefreshFailure(status, oauthError)).toBe(terminal);
  });
});

describe("readOAuthErrorCode", () => {
  it("reads the OAuth `error` code from a JSON token-endpoint body", async () => {
    const res = new Response(JSON.stringify({ error: "invalid_grant", error_description: "x" }), {
      status: 400,
    });
    await expect(readOAuthErrorCode(res)).resolves.toBe("invalid_grant");
  });

  it("leaves the response body unread so the caller can still consume it", async () => {
    const res = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    await readOAuthErrorCode(res);
    await expect(res.text()).resolves.toContain("invalid_grant");
  });

  it.each([
    ["a non-JSON body", "<html>bad gateway</html>"],
    ["JSON without an error field", JSON.stringify({ message: "nope" })],
    ["a non-string error field", JSON.stringify({ error: { code: 190 } })],
    ["an empty body", ""],
  ])("is undefined for %s", async (_label, body) => {
    await expect(readOAuthErrorCode(new Response(body, { status: 400 }))).resolves.toBeUndefined();
  });
});
