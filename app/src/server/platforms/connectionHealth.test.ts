import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isTerminalRefreshFailure,
  markConnectionNeedsReconnect,
  readOAuthErrorCode,
} from "@/server/platforms/connectionHealth";

// Mirrors googleTokens.test.ts: vi.mock + vi.hoisted are hoisted above
// imports, and markConnectionNeedsReconnect resolves prisma via
// `await import("@/lib/db")` at call time, so it receives this mock. No real
// database is touched.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
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
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
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
