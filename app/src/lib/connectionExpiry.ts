import type { Platform } from "@prisma/client";

import { formatDisplayDate } from "@/lib/displayDate";
import { platformLabel } from "@/lib/platforms";
import { EXPIRY_WARNING_LEAD_MS, hasUnrenewableExpiry } from "@/server/jobs/connectionHealthSweep";

/**
 * R6-pages M1 / R6-client-journey M1 (2026-11-14): the owners are warned a
 * week before a connection that cannot be renewed (LinkedIn) stops working.
 * Inside that window the connection still works, yet the only way forward
 * used to be Disconnect or Switch account, which delete its post numbers, and
 * a client link refused it as taken. This one rule says when the connection
 * may be reconnected in place instead: Settings shows Reconnect, the client's
 * /c page offers Reconnect, and the link's start and callback let the sign-in
 * replace it (the save updates the same row, so its numbers stay).
 *
 * Server side only: it reads `refreshToken`, so callers pass the boolean on.
 */

/** The columns {@link inExpiryWarningWindow} reads. */
export const CONNECTION_EXPIRY_SELECT = {
  platform: true,
  expiresAt: true,
  refreshToken: true,
  needsReconnect: true,
} as const;

export function inExpiryWarningWindow(
  connection: {
    platform: Platform;
    expiresAt: Date | string | null;
    refreshToken: string | null;
    needsReconnect: boolean;
  },
  now: Date = new Date(),
): boolean {
  // A flagged connection already shows Reconnect, and a link may replace it.
  if (connection.needsReconnect || !hasUnrenewableExpiry(connection)) return false;
  // Includes an expiry that has passed before the daily sweep flagged it.
  return new Date(connection.expiresAt!).getTime() - EXPIRY_WARNING_LEAD_MS <= now.getTime();
}

/**
 * Inside the window with the end date already passed (the daily sweep has not
 * flagged it yet): it no longer works, so the pages say it ended rather than
 * that it ends soon.
 */
export function expiryEnded(connection: Parameters<typeof inExpiryWarningWindow>[0], now: Date = new Date()): boolean {
  return inExpiryWarningWindow(connection, now) && new Date(connection.expiresAt!).getTime() <= now.getTime();
}

/**
 * R7-pages L4 / R7-client-journey L3: the one state every page shows for a
 * connection's end (Settings, the member view, the dashboard widget, the
 * Workspaces page), so none of them reads "Connected" for one that ends soon
 * or has ended. A flagged connection is null here: needsReconnect says it.
 */
export type ConnectionExpiryState = "ends_soon" | "ended" | null;

export function connectionExpiryState(
  connection: Parameters<typeof inExpiryWarningWindow>[0],
  now: Date = new Date(),
): ConnectionExpiryState {
  if (!inExpiryWarningWindow(connection, now)) return null;
  return expiryEnded(connection, now) ? "ended" : "ends_soon";
}

/**
 * Unconfirmed (R7 client-journey): a reconnect saved, yet the connection is
 * still inside its warning window, so the platform gave the same end date
 * (a fresh LinkedIn sign-in lasts 60 days). Said rather than looking as if
 * nothing happened.
 */

export function sameEndDateMessage(platform: Platform, expiresAt: Date | string): string {
  return `${platformLabel(platform)} gave the same end date (${formatDisplayDate(expiresAt)}); it still ends then.`;
}

/**
 * Does a new sign-in already end inside the warning window (LinkedIn answered
 * a reconnect with the same end date)? The callback and both choice routes
 * use it to add {@link SAME_END_PARAM}.
 */
export function signInEndsSoon(
  platform: Platform,
  expiresAt: Date | string | null,
  refreshToken: string | null,
  now: Date = new Date(),
): boolean {
  return inExpiryWarningWindow({ platform, expiresAt, refreshToken, needsReconnect: false }, now);
}

// Client-safe (lib/differentAccount.ts); re-exported for the server callers.
export { SAME_END_PARAM, connectedSuccessQuery } from "@/lib/differentAccount";
