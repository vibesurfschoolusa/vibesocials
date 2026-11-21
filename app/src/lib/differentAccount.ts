import type { Platform } from "@prisma/client";

import type { ShownControl } from "@/lib/oauthResult";
import { PLATFORM_LABELS, PLATFORM_ORDER, platformLabel } from "@/lib/platforms";

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
  // R59 fix review L1: a TikTok identifier is its opaque open_id, never shown.
  if (connection.platform === "tiktok") return connection.username || "the connected TikTok account";
  return connection.username || connection.accountIdentifier || `the connected ${platformLabel(connection.platform)} account`;
}

/**
 * R8-client-journey L2 / pages L1: a LinkedIn page and a Facebook Page are
 * not signed in to; an account that manages them is. R51 pages-a L2: an
 * Instagram account comes through Meta's Facebook login, from the Facebook
 * Page linked to it (instagram/start), so its sign-in is a Facebook account
 * that manages that Page (`linkedPage`). The platform's name for the account
 * signed in with, or no entry where the connection is the account itself.
 * `listsPages`: the sign-in then lists the Pages to tick (Meta's dialog).
 * `superAdmin`: only a Super admin of the page can connect it (R57 pages-a-3
 * L1: LinkedIn's callback accepts only its approved ADMINISTRATOR pages).
 */
const PAGE_ACCOUNT: Partial<
  Record<Platform, { account: string; linkedPage?: true; listsPages?: true; superAdmin?: true }>
> = {
  linkedin: { account: "LinkedIn", superAdmin: true },
  facebook_page: { account: "Facebook", listsPages: true },
  instagram: { account: "Facebook", linkedPage: true, listsPages: true },
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

/**
 * "sign in to <name>", or "sign in with a <platform> account that manages <the page>"
 * (LinkedIn: "that is a Super admin of <the page>").
 * `namedAs` ("it", "that Page"): for a sentence that has just named the page,
 * the short form refers back to it instead of naming it again (R52 lead
 * review: banners kept to 45 words). Only a sign-in that lists the Pages has one.
 */
export function signInTo(platform: Platform, name: string, namedAs?: string): string {
  const entry = PAGE_ACCOUNT[platform];
  if (!entry) return `sign in to ${name}`;
  const page = entry.listsPages && namedAs ? namedAs : managedPage(platform, name);
  const role = entry.superAdmin ? "is a Super admin of" : "manages";
  const signIn = `sign in with a ${entry.account} account that ${role} ${page}`;
  if (!entry.listsPages) return signIn;
  // R51 second look: someone who manages the Page but left it unticked in
  // Meta's list signed in rightly; ticking it is their step. R52
  // client-journey L1: a Facebook Page is ticked in the same list. Meta's
  // dialog may also list Instagram accounts, which can't be checked from
  // here, so Instagram's step is true whether or not it does.
  const tick = entry.linkedPage && !namedAs ? "tick that Page" : "tick it";
  const step = `${signIn} and ${tick} when ${entry.account} lists the Pages`;
  return entry.linkedPage ? `${step} (and its Instagram account, if listed)` : step;
}

/**
 * "<Sign in ...> to reconnect it". R51 last look: after a tick step, a
 * trailing "to reconnect it" reads as part of Facebook's list, so there it
 * comes first.
 */
function reconnectStep(platform: Platform, name: string, namedAs?: string): string {
  return PAGE_ACCOUNT[platform]?.listsPages
    ? `To reconnect it, ${signInTo(platform, name, namedAs)}`
    : `${capitalized(signInTo(platform, name))} to reconnect it`;
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
  // Facebook Page and Instagram (through Facebook) are chosen from a list
  // after the sign-in. R52 fix review L1: it names what the list shows. For
  // Instagram that is the accounts (offered is decided by the account's id),
  // so the Page itself may have come back; the step names it in full.
  const what = PAGE_ACCOUNT[platform]?.listsPages
    ? `You chose ${signedInName}; ${connectedName} wasn't listed.`
    : `You signed in to ${signedInName}, not ${connectedName}.`;
  return `${what} ${reconnectStep(platform, connectedName)}, or use Switch account to change to ${signedInName}.`;
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
    // The first sentence names the Page, so the step calls it "that Page".
    return `${notReturned}, so nothing changed. ${reconnectStep(platform, connectedName, "that Page")}, or use Switch account to change accounts.`;
  }
  if (entry) {
    return `${entry.account} connected a different page than ${connectedName}, so nothing changed. ${reconnectStep(platform, connectedName)}, or use Switch account to change pages.`;
  }
  const what = `You signed in to a different ${platformLabel(platform)} account than ${connectedName}.`;
  return `${what} ${reconnectStep(platform, connectedName)}, or use Switch account to change accounts.`;
}

/**
 * The client's /c page. R7-client-journey L4: a client can't switch the
 * account (that needs the connected account's own sign-in); what works is the
 * owner disconnecting it, then the client connecting theirs. R52
 * client-journey L1: for a page, someone who manages it may only have signed
 * in wrongly or left it unticked, so their own step comes first, as in the
 * owners' email. R58 client-journey L2: a LinkedIn Content admin manages the
 * page but can't connect it, so that step is a Super admin's. /c only offers a
 * sign-in for a flagged or ending connection, and that row's button is
 * Reconnect. R52 lead review: kept to 45 words, so
 * it opens with the page it names and says where to disconnect only to the
 * owner, who knows it.
 */
export function linkDifferentAccountMessage(platform: Platform, connectedName: string): string {
  const owner = "ask the workspace owner to disconnect it in Settings, Connections; then connect your account here.";
  if (platform === "linkedin") {
    return `This connection posts to ${connectedName}. If you are a Super admin of that page, sign out of LinkedIn first (Reconnect shows the steps), then ${signInTo(platform, connectedName)}. If not, ${owner}`;
  }
  if (PAGE_ACCOUNT[platform]?.listsPages) {
    return `If you manage ${managedPage(platform, connectedName)}, press Reconnect, ${signInTo(platform, connectedName, "it")}. If not, ask the workspace owner to disconnect it, then connect yours.`;
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
 * R54 client-journey L1: the code over a working row. A stale tab's Connect
 * is refused as a different account too (saveConnection.ts), and a reload or
 * Back after a reconnect worked keeps the code; nothing changed either way.
 * `connectedName` comes from the workspace's own row, never the address.
 * R54 fix review L1: an owner's working row shows Switch account on every
 * platform (connection-actions.tsx), the way to another account; a member
 * can't connect, so the member gets only what happened.
 */
export function differentAccountKeptMessage(platform: Platform, connectedName: string, isOwner: boolean): string {
  const kept = `Nothing changed: ${PLATFORM_LABELS[platform]} stays connected as ${connectedName}.`;
  return isOwner ? `${kept} To connect a different account instead, use Switch account.` : kept;
}

/**
 * Settings' choice. Offered: choosing it is the way forward. Not offered: the
 * person signed in to another account (for LinkedIn another member, so the
 * sign-out step); other platforms as before. R55 client-journey L1: the
 * reconnect wording only while the row shows Reconnect (`shown`); a stale
 * tab's Connect over a working row gets Settings' kept wording. Only an owner
 * reaches the choice.
 */
export function choiceDifferentAccountMessage(
  platform: Platform,
  chosenName: string,
  connectedName: string,
  connectedOffered: boolean,
  shown: ShownControl,
): string {
  if (connectedOffered) {
    return `You chose ${chosenName}, not ${connectedName}. Choose ${connectedName} to reconnect it, or use Switch account to change to ${chosenName}.`;
  }
  if (shown === "connected") return differentAccountKeptMessage(platform, connectedName, true);
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
