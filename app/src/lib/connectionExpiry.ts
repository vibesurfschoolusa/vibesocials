import type { Platform } from "@prisma/client";

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
