import type { Platform, Prisma } from "@prisma/client";

import { billingEnabled, PAST_DUE_GRACE_DAYS, type BillingEnv } from "@/lib/billing";

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
 *  - `refreshToken` non-null (R5-publishing L1): without one a refresh does
 *    nothing (Facebook and Instagram Page tokens, LinkedIn for this app), yet each
 *    match cost two Inngest executions a day, forever. Those connections get the
 *    pre-expiry warning instead (`expiryNoticeDue`) when their expiry is real.
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
  connection: {
    platform: Platform;
    needsReconnect: boolean;
    expiresAt: Date | string | null;
    refreshToken: string | null;
  },
  now: Date,
): boolean {
  if (connection.needsReconnect) return false;
  if (connection.refreshToken === null) return false;
  if (connection.expiresAt === null) return false;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (GOOGLE_PLATFORMS.includes(connection.platform)) {
    return expiresAt < now.getTime() - GOOGLE_IDLE_REFRESH_MS;
  }
  return expiresAt < now.getTime() + REFRESH_HORIZON_MS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * R9-publishing L3: a free workspace whose last post went out this long ago
 * is left out of the fan-out. Each connection costs two Inngest executions a
 * sweep and nothing counts them, so throwaway workspaces that never post
 * would spend the budget forever.
 */
export const IDLE_FREE_REFRESH_MS = 14 * DAY_MS;

/** A post that went out (or tried to): drafts, scheduled and cancelled ones never ran. */
const RAN_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

/**
 * R9-publishing L3: the workspaces whose connections the sweep refreshes:
 * grandfathered ones (billingExempt), with billing on those on a paid plan,
 * and any other that had a post go out in the last IDLE_FREE_REFRESH_MS.
 * Leaving an idle one out is safe because publishing refreshes an expired
 * token on use on every platform with a refresh token (TikTok, YouTube,
 * Google Business Profile, Pinterest, LinkedIn). The cost, accepted for a
 * free workspace: a refresh token can lapse while it is idle (Pinterest's 60
 * days after the last refresh, Google's six months unused), and then its next
 * post asks for a reconnect, as any dead grant does. "Paid" is paysForPlan
 * (lib/billing.ts) as SQL can say it: active, or past_due within the grace;
 * a past_due plan that was never paid is kept too, which only refreshes more.
 * A post retried or sent in the window updates the post, so updatedAt is when
 * it last ran.
 */
function refreshedWorkspaceWhere(now: Date, env: BillingEnv): Prisma.WorkspaceWhereInput {
  const paid: Prisma.WorkspaceWhereInput = {
    plan: { not: null },
    OR: [
      { planStatus: "active" },
      { planStatus: "past_due", currentPeriodEnd: { gt: new Date(now.getTime() - PAST_DUE_GRACE_DAYS * DAY_MS) } },
    ],
  };
  return {
    OR: [
      { billingExempt: true },
      ...(billingEnabled(env) ? [paid] : []),
      {
        postJobs: {
          some: { status: { in: [...RAN_STATUSES] }, updatedAt: { gte: new Date(now.getTime() - IDLE_FREE_REFRESH_MS) } },
        },
      },
    ],
  };
}

/**
 * {@link isProactiveRefreshEligible} as a Prisma WHERE, so the cron selects
 * the connections to refresh in SQL instead of loading every row. The two
 * must stay equivalent (connectionHealthSweep.test.ts evaluates one against
 * the other). R9-publishing L3: plus the workspace rule
 * ({@link refreshedWorkspaceWhere}), decided here only: the refresh function's
 * re-check is about the connection row.
 */
export function proactiveRefreshWhere(now: Date, env: BillingEnv = process.env): Prisma.SocialConnectionWhereInput {
  return {
    workspace: refreshedWorkspaceWhere(now, env),
    needsReconnect: false,
    refreshToken: { not: null },
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

/**
 * Platforms whose stored `expiresAt` is not the stored token's: they keep a
 * Facebook PAGE token, which does not expire on a clock, while `expiresAt` is
 * the 60 days of the user token it was minted from (facebookPageClient.ts,
 * instagramClient.ts). Only a Graph 190 / 401 says such a token is dead.
 */
const PAGE_TOKEN_PLATFORMS: Platform[] = ["facebook_page", "instagram"];

/**
 * How long before an expiry that cannot be renewed the owners are warned
 * (R5-publishing M1): a week leaves time to reconnect, or to send the client a
 * connect link, before posts start failing.
 */
export const EXPIRY_WARNING_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Does this connection stop working on its `expiresAt` with no way for us to
 * renew it? True with an expiry and no refresh token, on any platform but the
 * Page-token ones. Today that is LinkedIn (no refresh token for this app), and
 * any other platform that answered a connect without one.
 */
export function hasUnrenewableExpiry(connection: {
  platform: Platform;
  expiresAt: Date | string | null;
  refreshToken: string | null;
}): boolean {
  return (
    connection.expiresAt !== null &&
    connection.refreshToken === null &&
    !PAGE_TOKEN_PLATFORMS.includes(connection.platform)
  );
}

/**
 * Which notice the daily sweep owes a connection whose expiry cannot be renewed:
 *  - "warning": the expiry is at most EXPIRY_WARNING_LEAD_MS away and no warning
 *    was sent for THIS expiry (`expiryWarnedFor` holds the `expiresAt` the last
 *    warning was about; a reconnect writes a new `expiresAt`, so the next expiry
 *    is warned about again without anything being cleared);
 *  - "lapsed": the expiry has passed; the sweep flags the connection and the
 *    owners get the reconnect email;
 *  - null: nothing (not due, already warned, already flagged, or renewable).
 */
export function expiryNoticeDue(
  connection: {
    platform: Platform;
    expiresAt: Date | string | null;
    refreshToken: string | null;
    needsReconnect: boolean;
    expiryWarnedFor: Date | string | null;
  },
  now: Date,
): "warning" | "lapsed" | null {
  if (connection.needsReconnect || !hasUnrenewableExpiry(connection)) return null;
  const expiresAt = new Date(connection.expiresAt!).getTime();
  if (expiresAt <= now.getTime()) return "lapsed";
  if (expiresAt - EXPIRY_WARNING_LEAD_MS > now.getTime()) return null;
  const warnedFor = connection.expiryWarnedFor === null ? null : new Date(connection.expiryWarnedFor).getTime();
  return warnedFor === expiresAt ? null : "warning";
}

/**
 * The candidates for {@link expiryNoticeDue} as a Prisma WHERE: every connection
 * the rule could answer non-null for. Already-warned rows still match until they
 * lapse; the rule filters them. A small set: only unrenewable expiries within a week.
 */
export function expiryNoticeWhere(now: Date): Prisma.SocialConnectionWhereInput {
  return {
    needsReconnect: false,
    refreshToken: null,
    platform: { notIn: PAGE_TOKEN_PLATFORMS },
    expiresAt: { not: null, lte: new Date(now.getTime() + EXPIRY_WARNING_LEAD_MS) },
  };
}
