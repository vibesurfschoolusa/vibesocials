import type { Platform } from "@prisma/client";

import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";

/**
 * R6 review low 1 (2026-11-14): a reconnect (a flagged connection, or one in
 * its expiry warning window, from Settings or a client connect link) only
 * ever replaces a connection with the same platform account
 * (server/connections/saveConnection.ts saveSocialConnection). When a
 * different account comes back, nothing is changed and the callback answers
 * `<platform>_different_account`. These are the sentences for that, in
 * Settings and on /c. Changing to another account stays Switch account's job.
 *
 * R7-new-customer L2: the address carries no name. Anyone can send a link with
 * any query, so the sentences name only what the server knows: the stored
 * connection.
 */

const SUFFIX = "_different_account";
const CHECK_FAILED_SUFFIX = "_account_check_failed";

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
 * A choice among several accounts (api/connections/pending) that the save
 * refused: both names come from the platform's own answer on the server.
 */
export function settingsDifferentAccountMessage(signedInName: string, connectedName: string): string {
  return `You signed in to ${signedInName}, not ${connectedName}. Sign in to ${connectedName} to reconnect it, or use Switch account to change to ${signedInName}.`;
}

/**
 * Settings after a callback refused the reconnect. R7-pages M2: LinkedIn
 * connects whichever account is signed in to linkedin.com in this browser, so
 * signing in to the right one takes a sign-out first (Reconnect shows the steps).
 */
export function reconnectDifferentAccountMessage(platform: Platform, connectedName: string): string {
  const label = platformLabel(platform);
  const what = `You signed in to a different ${label} account than ${connectedName}.`;
  if (platform === "linkedin") {
    return `${what} Sign out of LinkedIn first (Reconnect shows the steps), then sign in to ${connectedName}. To use the other account instead, use Switch account.`;
  }
  return `${what} Sign in to ${connectedName} to reconnect it, or use Switch account to change accounts.`;
}

/**
 * The client's /c page. R7-client-journey L4: a client can't switch the
 * account (that needs the connected account's own sign-in); what works is the
 * owner disconnecting it, then the client connecting theirs.
 */
export function linkDifferentAccountMessage(platform: Platform, connectedName: string): string {
  const owner = "ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.";
  if (platform === "linkedin") {
    return `This connection belongs to ${connectedName}. If that is your account, sign out of LinkedIn first (Reconnect shows the steps), then sign in to ${connectedName}. If not, ${owner}`;
  }
  return `This connection belongs to ${connectedName}. ${owner.charAt(0).toUpperCase()}${owner.slice(1)}`;
}

/**
 * R7 review 3: a refused choice from a list (Pages, Instagram accounts,
 * LinkedIn pages, boards). Whether the connected account was one of the
 * candidates: `connectedKey` is its key as the save compares it
 * (saveConnection.ts connectionAccountKey), null when it can't be told.
 */
export function connectedAmongCandidates(candidates: readonly { id: string }[], connectedKey: string | null): boolean {
  return connectedKey !== null && candidates.some((candidate) => candidate.id === connectedKey);
}

/**
 * Settings' choice. Offered: choosing it is the way forward. Not offered: the
 * person signed in to another account (for LinkedIn another member, so the
 * sign-out step); other platforms as before.
 */
export function choiceDifferentAccountMessage(
  platform: Platform,
  chosenName: string,
  connectedName: string,
  connectedOffered: boolean,
): string {
  if (connectedOffered) {
    return `You chose ${chosenName}, not ${connectedName}. Choose ${connectedName} to reconnect it, or use Switch account to change to ${chosenName}.`;
  }
  return platform === "linkedin"
    ? reconnectDifferentAccountMessage(platform, connectedName)
    : settingsDifferentAccountMessage(chosenName, connectedName);
}

/** The client's choice on /c, by the same rule. */
export function linkChoiceDifferentAccountMessage(platform: Platform, connectedName: string, connectedOffered: boolean): string {
  return connectedOffered
    ? `Choose ${connectedName} from the list, or ask the workspace owner to disconnect it first.`
    : linkDifferentAccountMessage(platform, connectedName);
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
export type SaveRefusal = { reason: "different_account" } | { reason: "check_failed" };

/** Where a callback sends the owner when the save was refused (a link flow turns it into /c). */
export function refusedSaveSettingsUrl(base: string | URL, platform: Platform, refusal: SaveRefusal): URL {
  const url = new URL("/settings", base);
  if (refusal.reason === "check_failed") {
    url.searchParams.set("error", `${platform}${CHECK_FAILED_SUFFIX}`);
    return url;
  }
  url.searchParams.set("error", differentAccountCode(platform));
  return url;
}

/**
 * R6 third review: Google Business Profile is never refused as another
 * account. When the chosen location isn't available to the Google account
 * signed in to, the reconnect is saved with the location cleared, and this
 * parameter says so. R7-new-customer L2: a flag only ("1"), never the old
 * title; the pages show the sentence only when the connection really has no
 * location.
 */
export const LOCATION_CLEARED_PARAM = "location_cleared";

export function locationClearedSettingsMessage(): string {
  return "Reconnected. Choose the location to post to; the one chosen before isn't available to this Google account.";
}

export const LOCATION_CLEARED_LINK_MESSAGE = "Connected. The workspace owner will choose the location.";

/**
 * The flag the LinkedIn callback (and, through their dialogs, the two choice
 * routes) adds to the success address when the new sign-in itself ends
 * inside the warning window (lib/connectionExpiry.ts signInEndsSoon). A flag
 * only, never a name or a date: the pages read the date from the stored
 * connection and show the sentence only when it really is in that window.
 */
export const SAME_END_PARAM = "same_end";

/** The query a choice dialog sends the person back with, as the callback would. */
export function connectedSuccessQuery(platform: string, sameEnd: boolean): string {
  const query = new URLSearchParams({ success: `${platform}_connected` });
  if (sameEnd) query.set(SAME_END_PARAM, "1");
  return query.toString();
}
