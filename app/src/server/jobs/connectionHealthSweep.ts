/**
 * Connection health sweep — pure eligibility rule.
 *
 * Which connections should the daily cron proactively try to refresh?
 *  - `needsReconnect` false: a flagged connection is already dead and its
 *    owner already got the reconnect email (this sweep's transition email, or
 *    a failed-post email) — re-refreshing would just re-fail and re-spam.
 *  - `expiresAt` non-null and within REFRESH_HORIZON_MS of `now` (or past):
 *    refreshing daily keeps provider refresh-tokens alive (Google revokes
 *    grants unused for ~6 months — exactly how the prod GBP connection died
 *    on 2026-07-26) and surfaces a dead grant TODAY instead of at the next
 *    scheduled post. Connections with `expiresAt: null` (e.g. X OAuth1) have
 *    nothing to refresh.
 *
 * The cron (inngest-functions.ts) attempts `client.refreshToken(connection)`
 * for each eligible connection; platform clients persist the new token and,
 * on terminal failure, flip `needsReconnect` themselves (via
 * markConnectionNeedsReconnect) — the cron emails workspace owners exactly
 * when it observes that transition.
 */
export const REFRESH_HORIZON_MS = 24 * 60 * 60 * 1000;

export function isProactiveRefreshEligible(
  connection: { needsReconnect: boolean; expiresAt: Date | string | null },
  now: Date,
): boolean {
  if (connection.needsReconnect) return false;
  if (connection.expiresAt === null) return false;
  const expiresAt = new Date(connection.expiresAt);
  return expiresAt.getTime() < now.getTime() + REFRESH_HORIZON_MS;
}
