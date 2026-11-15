import type { Platform } from "@prisma/client";

import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";

/**
 * R6 review low 1 (2026-11-14): a reconnect (a flagged connection, or one in
 * its expiry warning window, from Settings or a client connect link) only
 * ever replaces a connection with the same platform account
 * (server/connections/saveConnection.ts saveSocialConnection). When a
 * different account comes back, nothing is changed and the callback answers
 * `<platform>_different_account`, with the name it signed in to in
 * `signed_in_as`. These are the sentences for that, in Settings and on /c.
 * Changing to another account stays Switch account's job.
 */

const SUFFIX = "_different_account";
const CHECK_FAILED_SUFFIX = "_account_check_failed";

/** The query parameter that carries the name of the account the person signed in to. */
export const SIGNED_IN_AS_PARAM = "signed_in_as";

const NAME_MAX_CHARS = 100;

export function differentAccountCode(platform: Platform): string {
  return `${platform}${SUFFIX}`;
}

/** The platform a `<platform>_different_account` code names, or null for any other code. */
export function differentAccountPlatform(code: string | null | undefined): Platform | null {
  if (!code || !code.endsWith(SUFFIX)) return null;
  const platform = code.slice(0, -SUFFIX.length);
  return (PLATFORM_ORDER as readonly string[]).includes(platform) ? (platform as Platform) : null;
}

/** A connection's name as Settings shows it ("Connected as ..."). */
export function connectedAccountName(connection: {
  platform: Platform;
  username: string | null;
  accountIdentifier: string;
}): string {
  return connection.username || connection.accountIdentifier || `the connected ${platformLabel(connection.platform)} account`;
}

/**
 * The signed-in name from the address. Anyone can type it, so it is only ever
 * shown as text, trimmed and capped; without one, a plain description.
 */
export function signedInNameFromQuery(value: string | string[] | null | undefined, platform: Platform): string {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  return raw ? raw.slice(0, NAME_MAX_CHARS) : `a different ${platformLabel(platform)} account`;
}

export function settingsDifferentAccountMessage(signedInName: string, connectedName: string): string {
  return `You signed in to ${signedInName}, not ${connectedName}. Sign in to ${connectedName} to reconnect it, or use Switch account to change to ${signedInName}.`;
}

export function linkDifferentAccountMessage(platform: Platform, connectedName: string): string {
  return `You signed in to a different ${platformLabel(platform)} account than the one connected (${connectedName}). Sign in to that account, or ask the workspace owner to switch it.`;
}

/**
 * R6 second review 1: Google Business Profile only. Whether the new Google
 * account manages the chosen location couldn't be read (a 429, 5xx or network
 * failure); nothing changed.
 */
export function accountCheckFailedPlatform(code: string | null | undefined): Platform | null {
  if (!code || !code.endsWith(CHECK_FAILED_SUFFIX)) return null;
  const platform = code.slice(0, -CHECK_FAILED_SUFFIX.length);
  return (PLATFORM_ORDER as readonly string[]).includes(platform) ? (platform as Platform) : null;
}

export function accountCheckFailedMessage(locationTitle: string): string {
  return `We couldn't check that this Google account manages ${locationTitle}. Try again in a minute.`;
}

/** A save the shared save refused (server/connections/saveConnection.ts). */
export type SaveRefusal = { reason: "different_account"; signedInName: string } | { reason: "check_failed" };

/** Where a callback sends the owner when the save was refused (a link flow turns it into /c). */
export function refusedSaveSettingsUrl(base: string | URL, platform: Platform, refusal: SaveRefusal): URL {
  const url = new URL("/settings", base);
  if (refusal.reason === "check_failed") {
    url.searchParams.set("error", `${platform}${CHECK_FAILED_SUFFIX}`);
    return url;
  }
  url.searchParams.set("error", differentAccountCode(platform));
  url.searchParams.set(SIGNED_IN_AS_PARAM, refusal.signedInName.slice(0, NAME_MAX_CHARS));
  return url;
}

/**
 * R6 third review: Google Business Profile is never refused as another
 * account. When the chosen location isn't available to the Google account
 * signed in to, the reconnect is saved with the location cleared, and this
 * parameter carries the old location's title ("" when it had none).
 */
export const LOCATION_CLEARED_PARAM = "location_cleared";

export function locationClearedSettingsMessage(oldTitle: string | null | undefined): string {
  const title = oldTitle?.trim().slice(0, 200) || "The location you chose";
  return `Reconnected. Choose the location to post to; ${title} isn't available to this Google account.`;
}

export const LOCATION_CLEARED_LINK_MESSAGE = "Connected. The workspace owner will choose the location.";
