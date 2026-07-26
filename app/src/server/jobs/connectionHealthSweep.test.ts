import { describe, expect, it } from "vitest";

import {
  REFRESH_HORIZON_MS,
  isProactiveRefreshEligible,
} from "./connectionHealthSweep";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function conn(
  overrides: Partial<{ needsReconnect: boolean; expiresAt: Date | null }> = {},
) {
  return {
    needsReconnect: false,
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

describe("isProactiveRefreshEligible", () => {
  it("refreshes a token already expired", () => {
    expect(isProactiveRefreshEligible(conn(), NOW)).toBe(true);
  });

  it("refreshes a token expiring within the 24h horizon", () => {
    const expiresAt = new Date(NOW.getTime() + REFRESH_HORIZON_MS - 60_000);
    expect(isProactiveRefreshEligible(conn({ expiresAt }), NOW)).toBe(true);
  });

  it("skips a token with plenty of life left", () => {
    const expiresAt = new Date(NOW.getTime() + REFRESH_HORIZON_MS + 60_000);
    expect(isProactiveRefreshEligible(conn({ expiresAt }), NOW)).toBe(false);
  });

  it("skips connections already flagged needsReconnect (owner already notified)", () => {
    expect(isProactiveRefreshEligible(conn({ needsReconnect: true }), NOW)).toBe(false);
  });

  it("skips connections with no expiry at all (e.g. X OAuth1 — nothing to refresh)", () => {
    expect(isProactiveRefreshEligible(conn({ expiresAt: null }), NOW)).toBe(false);
  });

  it("accepts ISO-string expiresAt (step.run serialization)", () => {
    expect(
      isProactiveRefreshEligible(
        {
          needsReconnect: false,
          expiresAt: "2026-04-01T00:00:00.000Z" as unknown as Date,
        },
        NOW,
      ),
    ).toBe(true);
  });
});
