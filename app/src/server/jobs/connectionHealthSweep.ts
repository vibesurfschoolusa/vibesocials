import type { Platform, Prisma } from "@prisma/client";

/**
 * Connection health sweep — pure eligibility rule.
 *
 * Which connections should the daily cron proactively try to refresh?
 *  - `needsReconnect` false: a flagged connection is already dead and its
 *    owner already got the reconnect email (this sweep's transition email, or
 *    a failed-post email) — re-refreshing would just re-fail and re-spam.
 *  - `expiresAt` non-null and within REFRESH_HORIZON_MS of `now` (or past):
 *    refreshing daily keeps provider refresh-tokens alive and surfaces a dead
 *    grant TODAY instead of at the next scheduled post. Connections with
 *    `expiresAt: null` (e.g. X OAuth1) have nothing to refresh.
 *  - Google (YouTube, Google Business Profile) is the exception: see
 *    GOOGLE_IDLE_REFRESH_MS.
 *
 * 2026-11-01 scale audit (jobs, token refresh): the cron no longer loads and
 * refreshes ~8,600 rows in one 300 s step (which never finished). It only PAGES
 * connection ids (`proactiveRefreshWhere`, the same rule as a SQL filter) and
 * fans each one out as a `connection/refresh.requested` event to the
 * `refresh-connection` function (inngest-functions.ts), which re-checks the rule
 * with `isProactiveRefreshEligible`, refreshes under the per-connection lock
 * (connectionRefresh.ts) and emails the owners exactly when it observes the
 * flag flip.
 */
export const REFRESH_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * A Google connection is refreshed only when it has been idle this long (7
 * days). A Google access token lives 1 h, so `expiresAt` is about the time of
 * the last refresh plus 1 h and no new column is needed; every publish, metrics
 * sync or review fetch that touched the connection since keeps it well inside
 * this. 7 days is far inside the 6-month unused-refresh-token expiry (V19,
 * https://developers.google.com/identity/protocols/oauth2: "not been used for
 * six months"; that is how the prod GBP connection died on 2026-07-26), so the
 * keep-alive still lands long before the grant could lapse, without refreshing
 * thousands of busy connections every day.
 */
export const GOOGLE_IDLE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Connection ids per page of the cron, and per `step.sendEvent` (Inngest
 * accepts up to 5,000 events per send, V7; our events are ~150 bytes).
 */
export const HEALTH_SWEEP_PAGE_SIZE = 1000;

/** Platforms whose OAuth refresh goes through Google's token endpoint. */
const GOOGLE_PLATFORMS: Platform[] = ["youtube", "google_business_profile"];

export function isProactiveRefreshEligible(
  connection: { platform: Platform; needsReconnect: boolean; expiresAt: Date | string | null },
  now: Date,
): boolean {
  if (connection.needsReconnect) return false;
  if (connection.expiresAt === null) return false;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (GOOGLE_PLATFORMS.includes(connection.platform)) {
    return expiresAt < now.getTime() - GOOGLE_IDLE_REFRESH_MS;
  }
  return expiresAt < now.getTime() + REFRESH_HORIZON_MS;
}

/**
 * {@link isProactiveRefreshEligible} as a Prisma WHERE, so the cron selects
 * the connections to refresh in SQL instead of loading every row. The two
 * must stay equivalent (connectionHealthSweep.test.ts evaluates one against
 * the other). A platform whose client has no `refreshToken` (LinkedIn) matches
 * the rule too; `refresh-connection` answers it `no_refresh`.
 */
export function proactiveRefreshWhere(now: Date): Prisma.SocialConnectionWhereInput {
  return {
    needsReconnect: false,
    OR: [
      {
        platform: { in: GOOGLE_PLATFORMS },
        expiresAt: { not: null, lt: new Date(now.getTime() - GOOGLE_IDLE_REFRESH_MS) },
      },
      {
        platform: { notIn: GOOGLE_PLATFORMS },
        expiresAt: { not: null, lt: new Date(now.getTime() + REFRESH_HORIZON_MS) },
      },
    ],
  };
}
