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
/** R27 lead review: worded by describeOAuthResult (Settings) and describeConnectLinkResult (/c). */
const PERMISSION_MISSING_SUFFIX = "_permission_missing";

export function differentAccountCode(platform: Platform): string {
  return `${platform}${SUFFIX}`;
}

/** The platform a `<platform>_different_account` code names, or null for any other code. */
export function differentAccountPlatform(code: string | null | undefined): Platform | null {
  if (!code || !code.endsWith(SUFFIX)) return null;
  const platform = code.slice(0, -SUFFIX.length);
  return (PLATFORM_ORDER as readonly string[]).includes(platform) ? (platform as Platform) : null;
}

/**
 * A connection's name as Settings shows it ("Connected as ..."). R8-client-
 * journey L2: a LinkedIn connection's stored name is its company page
 * (saveConnection.ts), and its identifier is the member's opaque profile id,
 * so without the name it is "the connected LinkedIn page".
 */
export function connectedAccountName(connection: {
  platform: Platform;
  username: string | null;
  accountIdentifier: string;
}): string {
  if (connection.platform === "linkedin") return connection.username || "the connected LinkedIn page";
  // R8 review: a Facebook Page's identifier is its numeric id.
  if (connection.platform === "facebook_page") return connection.username || "the connected Facebook Page";
  return connection.username || connection.accountIdentifier || `the connected ${platformLabel(connection.platform)} account`;
}

/**
 * R8-client-journey L2 / pages L1: a LinkedIn page and a Facebook Page are
 * not signed in to; an account that manages them is. R51 pages-a L2: an
 * Instagram account comes through Meta's Facebook login, from the Facebook
 * Page linked to it (instagram/start), so its sign-in is a Facebook account
 * that manages that Page (`linkedPage`). The platform's name for the account
 * signed in with, or no entry where the connection is the account itself.
 */
const PAGE_ACCOUNT: Partial<Record<Platform, { account: string; linkedPage?: true }>> = {
  linkedin: { account: "LinkedIn" },
  facebook_page: { account: "Facebook" },
  instagram: { account: "Facebook", linkedPage: true },
};

/** The account name for a connection that is itself a page (LinkedIn, Facebook Page), else null. */
export function pageAccountLabel(platform: Platform): string | null {
  const entry = PAGE_ACCOUNT[platform];
  return entry && !entry.linkedPage ? entry.account : null;
}

/** What the signed-in account has to manage: the page itself, or the Page linked to an Instagram account. */
function managedPage(platform: Platform, name: string): string {
  return PAGE_ACCOUNT[platform]?.linkedPage ? `the Page linked to ${name}` : name;
}

/**
 * For an account signed in through another platform's login (Instagram,
 * through Facebook): that login's name, else null.
 */
export function linkedPageAccount(platform: Platform): string | null {
  const entry = PAGE_ACCOUNT[platform];
  return entry?.linkedPage ? entry.account : null;
}

/** "Facebook didn't return the Page linked to <name>" for such an account, else null. */
export function linkedPageNotReturned(platform: Platform, name: string): string | null {
  const account = linkedPageAccount(platform);
  return account ? `${account} didn't return ${managedPage(platform, name)}` : null;
}

/** "sign in to <name>", or "sign in with a <platform> account that manages <the page>". */
export function signInTo(platform: Platform, name: string): string {
  const entry = PAGE_ACCOUNT[platform];
  if (!entry) return `sign in to ${name}`;
  const signIn = `sign in with a ${entry.account} account that manages ${managedPage(platform, name)}`;
  // R51 second look: someone who manages the Page but left it unticked in
  // Meta's list signed in rightly; ticking it is their step.
  return entry.linkedPage ? `${signIn}, and tick that Page when ${entry.account} lists the Pages` : signIn;
}

function capitalized(sentence: string): string {
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** The second step of LinkedIn's Reconnect (the Settings dialog and /c). */
export function linkedInReconnectSignInStep(pageName: string): string {
  return `Come back here and click Continue. LinkedIn asks you to sign in: ${signInTo("linkedin", pageName)}.`;
}

/**
 * A choice among several accounts (api/connections/pending) that the save
 * refused, the connected one not among them: both names come from the
 * platform's own answer on the server.
 */
export function settingsDifferentAccountMessage(platform: Platform, signedInName: string, connectedName: string): string {
  // Facebook Page and Instagram (through Facebook) are chosen from a list after the sign-in.
  const what =
    platform === "facebook_page" || platform === "instagram"
      ? `You chose ${signedInName}, not ${connectedName}, and ${connectedName} wasn't in the list.`
      : `You signed in to ${signedInName}, not ${connectedName}.`;
  return `${what} ${capitalized(signInTo(platform, connectedName))} to reconnect it, or use Switch account to change to ${signedInName}.`;
}

/**
 * Settings after a callback refused the reconnect. R7-pages M2: LinkedIn
 * connects whichever account is signed in to linkedin.com in this browser, so
 * signing in to the right one takes a sign-out first (Reconnect shows the steps).
 */
export function reconnectDifferentAccountMessage(platform: Platform, connectedName: string): string {
  const entry = PAGE_ACCOUNT[platform];
  if (platform === "linkedin") {
    return `LinkedIn connected a different page than ${connectedName}, so nothing changed. Sign out of LinkedIn first (Reconnect shows the steps), then ${signInTo(platform, connectedName)}. To use the other page instead, use Switch account.`;
  }
  const notReturned = linkedPageNotReturned(platform, connectedName);
  if (notReturned) {
    return `${notReturned}, so nothing changed. ${capitalized(signInTo(platform, connectedName))} to reconnect it, or use Switch account to change accounts.`;
  }
  if (entry) {
    return `${entry.account} connected a different page than ${connectedName}, so nothing changed. ${capitalized(signInTo(platform, connectedName))} to reconnect it, or use Switch account to change pages.`;
  }
  const what = `You signed in to a different ${platformLabel(platform)} account than ${connectedName}.`;
  return `${what} ${capitalized(signInTo(platform, connectedName))} to reconnect it, or use Switch account to change accounts.`;
}

/**
 * The client's /c page. R7-client-journey L4: a client can't switch the
 * account (that needs the connected account's own sign-in); what works is the
 * owner disconnecting it, then the client connecting theirs.
 */
export function linkDifferentAccountMessage(platform: Platform, connectedName: string): string {
  const owner = "ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.";
  if (platform === "linkedin") {
    return `This connection posts to ${connectedName}. If you manage that page, sign out of LinkedIn first (Reconnect shows the steps), then ${signInTo(platform, connectedName)}. If not, ${owner}`;
  }
  return `This connection belongs to ${connectedName}. ${capitalized(owner)}`;
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
    : settingsDifferentAccountMessage(platform, chosenName, connectedName);
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
export type SaveRefusal = { reason: "different_account" } | { reason: "check_failed" } | { reason: "permission_missing" };

/** Where a callback sends the owner when the save was refused (a link flow turns it into /c). */
export function refusedSaveSettingsUrl(base: string | URL, platform: Platform, refusal: SaveRefusal): URL {
  const url = new URL("/settings", base);
  if (refusal.reason === "permission_missing") {
    url.searchParams.set("error", `${platform}${PERMISSION_MISSING_SUFFIX}`);
    return url;
  }
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
