import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  EXPIRY_WARNING_LEAD_MS,
  GOOGLE_IDLE_REFRESH_MS,
  HEALTH_SWEEP_PAGE_SIZE,
  IDLE_FREE_REFRESH_MS,
  REFRESH_HORIZON_MS,
  expiryNoticeDue,
  expiryNoticeWhere,
  hasUnrenewableExpiry,
  isProactiveRefreshEligible,
  proactiveRefreshWhere,
} from "./connectionHealthSweep";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function conn(
  overrides: Partial<{
    platform: Platform;
    needsReconnect: boolean;
    expiresAt: Date | null;
    refreshToken: string | null;
  }> = {},
) {
  return {
    platform: "tiktok" as Platform,
    needsReconnect: false,
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    refreshToken: "refresh-token" as string | null,
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
          refreshToken: "refresh-token",
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

    it.each(["linkedin", "pinterest"] as const)(
      "%s with a refresh token expiring in 23 h -> eligible (other platforms keep the 24 h horizon)",
      (platform) => {
        const expiresAt = new Date(NOW.getTime() + 23 * HOUR);
        expect(isProactiveRefreshEligible(conn({ platform, expiresAt }), NOW)).toBe(true);
      },
    );
  });

  // R5-publishing L1: a refresh that can do nothing cost two executions a day per
  // connection, forever. Facebook and Instagram hold Page tokens with no refresh
  // token, and LinkedIn issues none to this app; the pre-expiry warning covers them.
  describe("a connection with no refresh token is never refreshed", () => {
    it.each(["facebook_page", "instagram", "linkedin", "tiktok", "youtube"] as const)("%s", (platform) => {
      const expiresAt = new Date(NOW.getTime() - 30 * DAY);
      expect(isProactiveRefreshEligible(conn({ platform, expiresAt, refreshToken: null }), NOW)).toBe(false);
    });
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

  it("excludes connections with no refresh token (nothing to refresh)", () => {
    expect(where.refreshToken).toEqual({ not: null });
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
      c.refreshToken !== null &&
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
      "pinterest",
    ];
    const offsets = [-30 * DAY, -8 * DAY, -6 * DAY, -HOUR, 0, 23 * HOUR, 25 * HOUR, 40 * DAY, null];
    for (const platform of platforms) {
      for (const offset of offsets) {
        for (const needsReconnect of [false, true]) {
          for (const refreshToken of ["refresh-token", null]) {
            const c = conn({
              platform,
              needsReconnect,
              refreshToken,
              expiresAt: offset === null ? null : new Date(NOW.getTime() + offset),
            });
            expect(matches(c), `${platform} ${offset} ${needsReconnect} ${refreshToken}`).toBe(
              isProactiveRefreshEligible(c, NOW),
            );
          }
        }
      }
    }
  });
});

// R9-publishing L3: the daily fan-out costs two executions a connection, so a
// free workspace that has not posted in 14 days is left out. Publishing
// refreshes an expired token on use on every platform that has a refresh
// token (TikTok, YouTube, Google Business Profile, Pinterest, LinkedIn: their
// client tests), so such a workspace's next post still goes.
describe("proactiveRefreshWhere: which workspaces' connections", () => {
  type Post = { status: string; updatedAt: Date };
  type Ws = {
    billingExempt: boolean;
    plan: string | null;
    planStatus: string | null;
    currentPeriodEnd: Date | null;
    posts: Post[];
  };
  const ON = { BILLING_ENABLED: "true" };
  const OFF = {};
  const FREE: Ws = { billingExempt: false, plan: null, planStatus: null, currentPeriodEnd: null, posts: [] };
  const posted = (daysAgo: number, status = "completed"): Post => ({ status, updatedAt: new Date(NOW.getTime() - daysAgo * DAY) });

  /** The workspace part of the WHERE, evaluated the way the database would. */
  function selects(ws: Ws, env: Record<string, string>): boolean {
    const where = proactiveRefreshWhere(NOW, env).workspace as { OR: Array<Record<string, unknown>> };
    return where.OR.some((branch) => {
      if ("billingExempt" in branch) return ws.billingExempt === branch.billingExempt;
      if ("postJobs" in branch) {
        const some = (branch.postJobs as { some: { status: { in: string[] }; updatedAt: { gte: Date } } }).some;
        return ws.posts.some((post) => some.status.in.includes(post.status) && post.updatedAt >= some.updatedAt.gte);
      }
      const paid = branch as { plan: { not: null }; OR: Array<{ planStatus: string; currentPeriodEnd?: { gt: Date } }> };
      return (
        ws.plan !== null &&
        paid.OR.some(
          (status) =>
            ws.planStatus === status.planStatus &&
            (!status.currentPeriodEnd || (ws.currentPeriodEnd !== null && ws.currentPeriodEnd > status.currentPeriodEnd.gt)),
        )
      );
    });
  }

  it("is pinned: a grandfathered workspace, a paid plan (billing on), or a post that went out in the last 14 days", () => {
    expect(IDLE_FREE_REFRESH_MS).toBe(14 * DAY);
    expect(proactiveRefreshWhere(NOW, ON).workspace).toEqual({
      OR: [
        { billingExempt: true },
        {
          plan: { not: null },
          OR: [{ planStatus: "active" }, { planStatus: "past_due", currentPeriodEnd: { gt: new Date(NOW.getTime() - 7 * DAY) } }],
        },
        {
          postJobs: {
            some: {
              status: { in: ["pending", "in_progress", "completed", "failed"] },
              updatedAt: { gte: new Date(NOW.getTime() - 14 * DAY) },
            },
          },
        },
      ],
    });
    // With billing off no workspace pays: only the grandfathered and the active ones.
    expect((proactiveRefreshWhere(NOW, OFF).workspace as { OR: unknown[] }).OR).toHaveLength(2);
  });

  it("an idle free workspace's TikTok and Google connections are not fanned out", () => {
    expect(selects(FREE, ON)).toBe(false);
    expect(selects(FREE, OFF)).toBe(false);
    // Posted 15 days ago, or only drafts, scheduled or cancelled posts since: idle.
    expect(selects({ ...FREE, posts: [posted(15)] }, ON)).toBe(false);
    for (const status of ["draft", "scheduled", "cancelled"]) {
      expect(selects({ ...FREE, posts: [posted(1, status)] }, ON), status).toBe(false);
    }
    // A plan still in its card trial, or one that ended, is free.
    expect(selects({ ...FREE, plan: "pro", planStatus: "trialing", currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY) }, ON)).toBe(false);
    expect(selects({ ...FREE, plan: "pro", planStatus: "canceled" }, ON)).toBe(false);
    expect(selects({ ...FREE, plan: "pro", planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 8 * DAY) }, ON)).toBe(false);
  });

  it("the same workspace once it posts (a run, a failed one too, in the last 14 days) is fanned out again", () => {
    for (const status of ["pending", "in_progress", "completed", "failed"]) {
      expect(selects({ ...FREE, posts: [posted(13, status)] }, ON), status).toBe(true);
      expect(selects({ ...FREE, posts: [posted(13, status)] }, OFF), status).toBe(true);
    }
  });

  it("a paid or grandfathered workspace is refreshed as now, idle or not", () => {
    expect(selects({ ...FREE, plan: "growth", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }, ON)).toBe(true);
    expect(selects({ ...FREE, plan: "growth", planStatus: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 3 * DAY) }, ON)).toBe(true);
    expect(selects({ ...FREE, billingExempt: true }, ON)).toBe(true);
    expect(selects({ ...FREE, billingExempt: true }, OFF)).toBe(true);
  });

  it("keeps the connection part as it was", () => {
    expect(proactiveRefreshWhere(NOW, ON)).toEqual({
      workspace: expect.anything(),
      needsReconnect: false,
      refreshToken: { not: null },
      OR: proactiveRefreshWhere(NOW, OFF).OR,
    });
  });
});

// R5-publishing M1: a token that cannot be renewed (LinkedIn gives this app no
// refresh token) used to die on its expiry date without a word to anyone.
describe("hasUnrenewableExpiry", () => {
  it("is true for a LinkedIn (or any other) connection with an expiry and no refresh token", () => {
    expect(hasUnrenewableExpiry(conn({ platform: "linkedin", refreshToken: null }))).toBe(true);
    expect(hasUnrenewableExpiry(conn({ platform: "tiktok", refreshToken: null }))).toBe(true);
  });

  it("is false when a refresh token can renew it", () => {
    expect(hasUnrenewableExpiry(conn({ platform: "linkedin" }))).toBe(false);
  });

  it("is false with no expiry (X OAuth 1.0a)", () => {
    expect(hasUnrenewableExpiry(conn({ platform: "x", expiresAt: null, refreshToken: null }))).toBe(false);
  });

  // Their stored expiresAt is the user token's 60 days, not the Page token's,
  // which does not expire on a clock: only a Graph 190 / 401 says it is dead.
  it.each(["facebook_page", "instagram"] as const)("is false for %s (a Page token)", (platform) => {
    expect(hasUnrenewableExpiry(conn({ platform, refreshToken: null }))).toBe(false);
  });
});

describe("expiryNoticeDue", () => {
  const linkedin = (
    expiresIn: number,
    more: Partial<{ expiryWarnedFor: Date | null; needsReconnect: boolean }> = {},
  ) => ({
    ...conn({ platform: "linkedin", refreshToken: null, expiresAt: new Date(NOW.getTime() + expiresIn) }),
    expiryWarnedFor: null as Date | null,
    ...more,
  });

  it("pins the lead time at 7 days", () => {
    expect(EXPIRY_WARNING_LEAD_MS).toBe(7 * DAY);
  });

  it("nothing while more than 7 days are left", () => {
    expect(expiryNoticeDue(linkedin(7 * DAY + HOUR), NOW)).toBeNull();
  });

  it("a warning once 7 days or fewer are left", () => {
    expect(expiryNoticeDue(linkedin(7 * DAY), NOW)).toBe("warning");
    expect(expiryNoticeDue(linkedin(HOUR), NOW)).toBe("warning");
  });

  it("no second warning for the same expiry", () => {
    const row = linkedin(3 * DAY);
    expect(expiryNoticeDue({ ...row, expiryWarnedFor: row.expiresAt }, NOW)).toBeNull();
  });

  it("a warning sent for an earlier expiry does not count (reconnected since)", () => {
    const row = linkedin(3 * DAY, { expiryWarnedFor: new Date(NOW.getTime() - 50 * DAY) });
    expect(expiryNoticeDue(row, NOW)).toBe("warning");
  });

  it("'lapsed' once the expiry has passed, warned or not", () => {
    const row = linkedin(-HOUR);
    expect(expiryNoticeDue(row, NOW)).toBe("lapsed");
    expect(expiryNoticeDue({ ...row, expiryWarnedFor: row.expiresAt }, NOW)).toBe("lapsed");
    expect(expiryNoticeDue(linkedin(0), NOW)).toBe("lapsed");
  });

  it("nothing for a flagged connection (the reconnect email covers it)", () => {
    expect(expiryNoticeDue(linkedin(-HOUR, { needsReconnect: true }), NOW)).toBeNull();
    expect(expiryNoticeDue(linkedin(DAY, { needsReconnect: true }), NOW)).toBeNull();
  });

  it("nothing for a renewable or Page-token connection", () => {
    expect(expiryNoticeDue({ ...linkedin(DAY), refreshToken: "refresh-token" }, NOW)).toBeNull();
    expect(expiryNoticeDue({ ...linkedin(-DAY), platform: "instagram" as Platform }, NOW)).toBeNull();
    expect(expiryNoticeDue({ ...linkedin(-DAY), platform: "facebook_page" as Platform }, NOW)).toBeNull();
  });

  it("accepts ISO strings (step output)", () => {
    const row = linkedin(DAY);
    const iso = row.expiresAt!.toISOString() as unknown as Date;
    expect(expiryNoticeDue({ ...row, expiresAt: iso, expiryWarnedFor: iso }, NOW)).toBeNull();
  });
});

describe("expiryNoticeWhere", () => {
  it("selects unflagged connections with no refresh token that expire within 7 days (or have), Page tokens left out", () => {
    expect(expiryNoticeWhere(NOW)).toEqual({
      needsReconnect: false,
      refreshToken: null,
      platform: { notIn: ["facebook_page", "instagram"] },
      expiresAt: { not: null, lte: new Date(NOW.getTime() + 7 * DAY) },
    });
  });
});
