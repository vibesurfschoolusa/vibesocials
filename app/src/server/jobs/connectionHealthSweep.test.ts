import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  GOOGLE_IDLE_REFRESH_MS,
  HEALTH_SWEEP_PAGE_SIZE,
  REFRESH_HORIZON_MS,
  isProactiveRefreshEligible,
  proactiveRefreshWhere,
} from "./connectionHealthSweep";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function conn(
  overrides: Partial<{ platform: Platform; needsReconnect: boolean; expiresAt: Date | null }> = {},
) {
  return {
    platform: "tiktok" as Platform,
    needsReconnect: false,
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

describe("constants", () => {
  it("pins the Google idle window (7 days) and the page size", () => {
    expect(GOOGLE_IDLE_REFRESH_MS).toBe(604_800_000);
    expect(HEALTH_SWEEP_PAGE_SIZE).toBe(1000);
  });
});

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
    expect(isProactiveRefreshEligible(conn({ platform: "x", expiresAt: null }), NOW)).toBe(false);
    expect(isProactiveRefreshEligible(conn({ expiresAt: null }), NOW)).toBe(false);
  });

  it("accepts ISO-string expiresAt (step.run serialization)", () => {
    expect(
      isProactiveRefreshEligible(
        {
          platform: "tiktok",
          needsReconnect: false,
          expiresAt: "2026-04-01T00:00:00.000Z" as unknown as Date,
        },
        NOW,
      ),
    ).toBe(true);
  });

  describe("TikTok keeps the 24 h horizon", () => {
    it("expiring in 23 h -> eligible", () => {
      const expiresAt = new Date(NOW.getTime() + 23 * HOUR);
      expect(isProactiveRefreshEligible(conn({ platform: "tiktok", expiresAt }), NOW)).toBe(true);
    });

    it("expiring in 25 h -> not eligible", () => {
      const expiresAt = new Date(NOW.getTime() + 25 * HOUR);
      expect(isProactiveRefreshEligible(conn({ platform: "tiktok", expiresAt }), NOW)).toBe(false);
    });

    it.each(["linkedin", "instagram", "facebook_page"] as const)(
      "%s expiring in 23 h -> eligible (other platforms keep the 24 h horizon)",
      (platform) => {
        const expiresAt = new Date(NOW.getTime() + 23 * HOUR);
        expect(isProactiveRefreshEligible(conn({ platform, expiresAt }), NOW)).toBe(true);
      },
    );
  });

  // 2026-11-01 scale audit (jobs, token refresh): a Google access token lives 1 h,
  // so its expiresAt is about the last refresh + 1 h. Refreshing every expired
  // Google token daily is ~8,600 pointless calls; only one idle for ~7 days (far
  // inside the 6-month unused-refresh-token expiry, V19) needs the keep-alive.
  describe.each(["youtube", "google_business_profile"] as const)("%s: idle-only", (platform) => {
    it("expired 8 days ago -> eligible", () => {
      const expiresAt = new Date(NOW.getTime() - 8 * DAY);
      expect(isProactiveRefreshEligible(conn({ platform, expiresAt }), NOW)).toBe(true);
    });

    it("expired 6 days ago -> not eligible", () => {
      const expiresAt = new Date(NOW.getTime() - 6 * DAY);
      expect(isProactiveRefreshEligible(conn({ platform, expiresAt }), NOW)).toBe(false);
    });

    it("expired a minute ago, or expiring within 24 h -> not eligible (used recently)", () => {
      expect(
        isProactiveRefreshEligible(conn({ platform, expiresAt: new Date(NOW.getTime() - 60_000) }), NOW),
      ).toBe(false);
      expect(
        isProactiveRefreshEligible(conn({ platform, expiresAt: new Date(NOW.getTime() + HOUR) }), NOW),
      ).toBe(false);
    });

    it("is eligible exactly past the idle window, not at it", () => {
      expect(
        isProactiveRefreshEligible(
          conn({ platform, expiresAt: new Date(NOW.getTime() - GOOGLE_IDLE_REFRESH_MS) }),
          NOW,
        ),
      ).toBe(false);
      expect(
        isProactiveRefreshEligible(
          conn({ platform, expiresAt: new Date(NOW.getTime() - GOOGLE_IDLE_REFRESH_MS - 1) }),
          NOW,
        ),
      ).toBe(true);
    });

    it("a flagged or expiry-less Google connection is still skipped", () => {
      const expiresAt = new Date(NOW.getTime() - 30 * DAY);
      expect(isProactiveRefreshEligible(conn({ platform, expiresAt, needsReconnect: true }), NOW)).toBe(false);
      expect(isProactiveRefreshEligible(conn({ platform, expiresAt: null }), NOW)).toBe(false);
    });
  });
});

// The cron pages ids with this WHERE (one SQL filter instead of loading ~8,600
// full rows); it must select exactly what isProactiveRefreshEligible accepts.
describe("proactiveRefreshWhere", () => {
  const where = proactiveRefreshWhere(NOW);

  it("excludes flagged connections", () => {
    expect(where.needsReconnect).toBe(false);
  });

  it("is a two-branch OR: Google idle-only, every other platform on the 24 h horizon", () => {
    expect(where.OR).toEqual([
      {
        platform: { in: ["youtube", "google_business_profile"] },
        expiresAt: { not: null, lt: new Date(NOW.getTime() - GOOGLE_IDLE_REFRESH_MS) },
      },
      {
        platform: { notIn: ["youtube", "google_business_profile"] },
        expiresAt: { not: null, lt: new Date(NOW.getTime() + REFRESH_HORIZON_MS) },
      },
    ]);
  });

  it("never selects a null expiresAt (X OAuth 1.0a)", () => {
    for (const branch of where.OR as Array<{ expiresAt: { not: null } }>) {
      expect(branch.expiresAt.not).toBeNull();
    }
  });

  // Evaluate the WHERE in JS and compare it with the pure rule over a grid.
  it("selects the same connections as isProactiveRefreshEligible", () => {
    type Branch = {
      platform: { in?: Platform[]; notIn?: Platform[] };
      expiresAt: { not: null; lt: Date };
    };
    const matches = (c: ReturnType<typeof conn>) =>
      c.needsReconnect === false &&
      (where.OR as Branch[]).some((branch) => {
        if (c.expiresAt === null) return false;
        const platformOk = branch.platform.in
          ? branch.platform.in.includes(c.platform)
          : !branch.platform.notIn!.includes(c.platform);
        return platformOk && c.expiresAt.getTime() < branch.expiresAt.lt.getTime();
      });

    const platforms: Platform[] = [
      "tiktok",
      "youtube",
      "x",
      "linkedin",
      "instagram",
      "google_business_profile",
      "facebook_page",
    ];
    const offsets = [-30 * DAY, -8 * DAY, -6 * DAY, -HOUR, 0, 23 * HOUR, 25 * HOUR, 40 * DAY, null];
    for (const platform of platforms) {
      for (const offset of offsets) {
        for (const needsReconnect of [false, true]) {
          const c = conn({
            platform,
            needsReconnect,
            expiresAt: offset === null ? null : new Date(NOW.getTime() + offset),
          });
          expect(matches(c), `${platform} ${offset} ${needsReconnect}`).toBe(
            isProactiveRefreshEligible(c, NOW),
          );
        }
      }
    }
  });
});
