import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markConnectionNeedsReconnect } from "@/server/platforms/connectionHealth";

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
