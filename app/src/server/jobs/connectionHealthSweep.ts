import type { Platform, Prisma } from "@prisma/client";

import { BILLING_FIELDS_SELECT, type BillingEnv, type BillingFields } from "@/lib/billing";
import { isOperatorUser } from "@/lib/operator";
import { serviceCapApplies } from "@/server/usage/usageLog";

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
 * flag flip. R10 (V3): only paid, grandfathered and operator-owned workspaces'
 * connections are fanned out; free workspaces' are refreshed in the cron's own
 * step (FREE_INLINE_REFRESH_DAILY_CAP).
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

/**
 * {@link isProactiveRefreshEligible} as a Prisma WHERE, so the cron selects
 * the connections to refresh in SQL instead of loading every row. The two
 * must stay equivalent (connectionHealthSweep.test.ts evaluates one against
 * the other).
 */
export function proactiveRefreshWhere(now: Date): Prisma.SocialConnectionWhereInput {
  return {
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
 * R10 (V3): a free workspace's due connections are refreshed by the sweep
 * itself, in one step, instead of fanned out. A fanned-out refresh costs two
 * Inngest executions that no limit counts, so free workspaces (throwaway ones
 * included) could spend the plan's budget without posting; inline, all of
 * them together cost the one step. At most this many a day, soonest-expiring
 * first; the rest are the soonest the next day.
 */
export const FREE_INLINE_REFRESH_DAILY_CAP = 100;

/**
 * How long the inline step may spend refreshing: no refresh starts after it,
 * and each gets it as its deadline (the lock wait, the lock transaction and
 * the platform request all end by it, connectionRefresh.ts). The Inngest route
 * may run 300 s (app/vercel.json); the 100 s left cover the reconnect emails
 * and the writes after the last refresh. A refresh is one token request and a
 * few queries, about 1 s, so the cap's 100 take about 100 s; the budget allows
 * 2 s each. A slow provider (up to a 20 s lock wait and a 30 s request) uses
 * it up sooner, and what is left waits for the next day.
 */
export const INLINE_REFRESH_BUDGET_MS = 200_000;

/**
 * What the cron reads per due connection: its expiry and whether its last
 * refresh failed (to order the inline queue) and its workspace's plan columns
 * and owners (to tell free from paid). No token column.
 */
export const SWEEP_PAGE_SELECT = {
  id: true,
  expiresAt: true,
  refreshFailedAt: true,
  workspace: {
    select: {
      ...BILLING_FIELDS_SELECT,
      members: {
        where: { role: "owner" },
        select: { user: { select: { email: true, emailVerifiedAt: true } } },
      },
    },
  },
} as const satisfies Prisma.SocialConnectionSelect;

export type SweepWorkspace = BillingFields & {
  members: Array<{ user: { email: string; emailVerifiedAt: Date | null } }>;
};

/**
 * Whether the sweep refreshes this workspace's connections itself: exactly the
 * workspaces the service's free pools count (serviceCapApplies, usageLog.ts):
 * not grandfathered, no operator among the owners, and, with billing on, not
 * paid for (paysForPlan; a card trial is not paid yet). Paid, grandfathered
 * and operator-owned workspaces keep the fan-out.
 */
export function refreshesInline(workspace: SweepWorkspace, now: Date, env: BillingEnv = process.env): boolean {
  const operatorOwned = workspace.members.some((member) => isOperatorUser(member.user, env));
  return serviceCapApplies(workspace, operatorOwned, now, env);
}

/**
 * A due connection of a free workspace, as a step output carries it. `failed`:
 * its last refresh attempt failed without flagging it (`refreshFailedAt` on an
 * unflagged row; every refresher's success write clears it).
 */
export type InlineRefreshCandidate = { id: string; expiresAt: string; failed?: boolean };

/**
 * The free connections to refresh today: those whose last refresh failed after
 * the healthy ones, each soonest-expiring first (ties by id), at most `cap`;
 * the count left is reported. A failing connection keeps its old expiresAt, so
 * by expiry alone a few failing or hanging ones would come first every day and
 * push healthy ones to the next.
 */
export function inlineRefreshQueue(
  candidates: readonly InlineRefreshCandidate[],
  cap: number = FREE_INLINE_REFRESH_DAILY_CAP,
): { ids: string[]; leftForTomorrow: number } {
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(a.failed === true) - Number(b.failed === true) ||
      new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ids = ordered.slice(0, cap).map((candidate) => candidate.id);
  return { ids, leftForTomorrow: candidates.length - ids.length };
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
