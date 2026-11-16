import { Platform, Prisma } from "@prisma/client";

import { toConnectionSummary } from "@/lib/connectionSummary";
import { prisma } from "@/lib/db";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { connectedAccountName } from "@/lib/differentAccount";
import { platformLabel } from "@/lib/platforms";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { LINKEDIN_SCOPES } from "@/lib/oauthScopes";
import type { PinterestBoard } from "@/lib/pinterestApi";
import type { PinterestAccount } from "@/server/connections/pinterestAccount";
import { googleFailureKind } from "@/server/googleFailure";
import { exactStoreCodeMatches, readGbpLocations, storeCodeFilter } from "@/server/platforms/gbpLocation";
import { readGoogleErrorReasons } from "@/server/platforms/rateLimited";

/**
 * Saving the account a user chose to connect (2026-11-09).
 *
 * The Facebook Page, Instagram and LinkedIn OAuth callbacks connect straight
 * away when the user manages exactly one account. When they manage several,
 * the callback parks them in a PendingConnection and the user picks one in
 * Settings (POST /api/connections/pending/[id]). Both paths save through the
 * functions below, so a chosen account is stored exactly like a lone one.
 *
 * Tokens are passed in plaintext: lib/db.ts seals accessToken/refreshToken on
 * every SocialConnection write.
 */

/**
 * Roadmap Phase 4: a successful (re)connect clears the flag a prior
 * refresh/COR-5 reconnect-required failure set (see
 * server/platforms/connectionHealth.ts); a fresh connect starts healthy.
 */
const HEALTHY = {
  needsReconnect: false,
  lastRefreshErrorCode: null,
  refreshFailedAt: null,
} as const;

interface ConnectionOwner {
  userId: string;
  workspaceId: string;
}

/**
 * What a connection posts as, compared when a sign-in comes back for a
 * platform the workspace already has (R6 review low 1). Null when it can't be
 * told, and then the save is not refused on it.
 *  - LinkedIn: the company page posts go to (`metadata.organizations[0]`),
 *    not the member who signed in.
 *  - YouTube: the channel id (`accountIdentifier` is the channel's title).
 *  - Pinterest: the account id (`metadata.accountId`, stable; a username can
 *    change); a row saved before it was kept has the username only.
 *  - Google Business Profile: none. Its token names no account (only
 *    business.manage is asked), so the chosen location decides (gbpVerdict).
 *  - Every other platform: the stored account or page id.
 */
export function connectionAccountKey(row: { platform: Platform; accountIdentifier: string; metadata: unknown }): string | null {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (row.platform === Platform.linkedin) {
    const organizations = Array.isArray(metadata.organizations) ? metadata.organizations : [];
    const id = (organizations[0] as { id?: unknown } | undefined)?.id;
    return id === undefined || id === null || id === "" ? null : String(id);
  }
  if (row.platform === Platform.youtube && typeof metadata.channelId === "string" && metadata.channelId) {
    return metadata.channelId;
  }
  if (row.platform === Platform.pinterest && typeof metadata.accountId === "string" && metadata.accountId) {
    return metadata.accountId;
  }
  if (row.platform === Platform.google_business_profile) return null;
  return row.accountIdentifier || null;
}

export type SaveConnectionResult =
  /**
   * Saved. `locationCleared` (Business Profile only): the chosen location
   * isn't available to the account signed in to, so it was cleared and the
   * owner chooses again; its title, for the sentence ("" when it had none).
   */
  | { ok: true; locationCleared?: string }
  /** A connection with another account is there; nothing was written. */
  | { ok: false; reason: "different_account"; connectedName: string; signedInName: string }
  /** Google Business Profile: the chosen location couldn't be checked with the new sign-in; nothing was written. */
  | { ok: false; reason: "check_failed"; connectedName: string };

type StoredConnection = {
  id: string;
  updatedAt: Date;
  platform: Platform;
  accountIdentifier: string;
  metadata: Prisma.JsonValue;
  needsReconnect: boolean;
};

const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GBP_CHECK_TIMEOUT_MS = 15_000;

/** The location id of `accounts/{a}/locations/{l}` or `locations/{l}`, or null for a store code. */
function locationIdOf(resourceName: string): string | null {
  const match = /(?:^|\/)locations\/([^/]+)$/.exec(resourceName);
  return match ? match[1] : null;
}

/** What the new sign-in can do with the Business Profile location the connection posts to. */
type GbpLocationCheck = "kept" | "unavailable" | "check_failed";

async function gbpGet(url: string | URL, accessToken: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, GBP_CHECK_TIMEOUT_MS);
}

/**
 * A store code is found only among the locations the signed-in account
 * manages, read with the shared paged listing (platforms/gbpLocation.ts) and
 * Google's storeCode filter. R26 platform-clients L2: the store-code lookup's
 * own rule, so a sign-in keeps what publishing would post to. Exactly one
 * match keeps it; more than one is unavailable. None is unavailable when the
 * list is complete or only accounts that refused access are missing (they
 * can't be posted to either); none while an account failed, or the list ran
 * past its page cap, is check_failed, never "not found". Nothing is flagged
 * here: the token was just granted, and the row is being saved.
 */
async function checkGbpStoreCode(storeCode: string, accessToken: string): Promise<GbpLocationCheck> {
  const listing = await readGbpLocations({
    where: "GBP sign-in store code check",
    get: (url) => gbpGet(url, accessToken),
    used: () => null,
    locationsFilter: storeCodeFilter(storeCode),
  });
  if (!listing.ok) return "check_failed";
  const matches = exactStoreCodeMatches(listing.locations, storeCode).length;
  if (matches === 1) return "kept";
  if (matches > 1) return "unavailable";
  return listing.complete || listing.refusedOnly ? "unavailable" : "check_failed";
}

/**
 * R6 third review: whether the location this Business Profile connection
 * posts to can be used by the Google account just signed in to, read with the
 * NEW token (one Business Information call, readMask=name). 200: kept; an
 * access 403 or a 404 (another account, or the location deleted on Google):
 * unavailable, and the location is cleared so the chooser asks again;
 * anything else (a 403 for our own setup or quota, 429, 5xx, network): it
 * couldn't be told, and nothing is written. No location chosen yet: nothing
 * to check.
 */
async function checkGbpLocation(existing: StoredConnection, accessToken: unknown): Promise<GbpLocationCheck> {
  const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
  const locationName = typeof metadata.locationName === "string" ? metadata.locationName.trim() : "";
  if (!locationName) return "kept";
  if (typeof accessToken !== "string" || !accessToken) return "check_failed";
  try {
    const locationId = locationIdOf(locationName);
    if (!locationId) return await checkGbpStoreCode(locationName, accessToken);
    const response = await gbpGet(
      `${BUSINESS_INFO_BASE}/locations/${encodeURIComponent(locationId)}?readMask=name`,
      accessToken,
    );
    if (response.ok) return "kept";
    if (response.status === 404) return "unavailable";
    // R27 client-journey L4: only an access 403 is another account. Our own
    // API setup or quota (googleFailureKind "tryLater") says nothing about it.
    if (response.status === 403) {
      const googleReasons = await readGoogleErrorReasons(response);
      if (googleFailureKind({ status: 403, googleReasons }) === "access") return "unavailable";
      logger.warn("[GBP] Couldn't check the location with the new sign-in", { connectionId: existing.id, status: 403, reasons: googleReasons });
      return "check_failed";
    }
    logger.warn("[GBP] Couldn't check the location with the new sign-in", { connectionId: existing.id, status: response.status });
    return "check_failed";
  } catch (error) {
    logger.warn("[GBP] Couldn't check the location with the new sign-in", {
      connectionId: existing.id,
      error: error instanceof Error ? error.name : typeof error,
    });
    return "check_failed";
  }
}

/** Is the stored connection for the same account as the sign-in? (Not Business Profile: see checkGbpLocation.) */
function sameAccount(
  existing: StoredConnection,
  incoming: { platform: Platform; accountIdentifier: string; metadata: unknown },
): boolean {
  let stored = connectionAccountKey(existing);
  let signedIn = connectionAccountKey(incoming);
  // A Pinterest row from before the account id was kept: compare usernames.
  const storedMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
  if (incoming.platform === Platform.pinterest && !(typeof storedMetadata.accountId === "string" && storedMetadata.accountId)) {
    signedIn = incoming.accountIdentifier || null;
  }
  if (stored === null || signedIn === null) stored = signedIn = null;
  return stored === signedIn;
}

const SAVE_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

/**
 * The one save every connect goes through (each OAuth callback, and the
 * account chosen in a waiting choice, in Settings or on /c). R6 review low 1:
 * a sign-in replaces the workspace's connection for that platform only with
 * the same account (sameAccountVerdict), on the same row, so its post numbers
 * stay. A different account leaves the row and its tokens as they are;
 * changing account is Switch account, which disconnects first, so there is no
 * row and the new account is simply created.
 *
 * R6 second review 3: no last write wins. The update applies only while the
 * row is still the one compared (same id and updatedAt), and a create only
 * while there is no row; otherwise the row is read and compared again, so of
 * two different accounts signing in at once the second is refused.
 */
export async function saveSocialConnection({
  userId,
  workspaceId,
  platform,
  signedInName,
  create,
  update,
}: ConnectionOwner & {
  platform: Platform;
  /** The name of the account the person signed in to, for the refusal sentence. */
  signedInName: string | null;
  create: Omit<Prisma.SocialConnectionUncheckedCreateInput, "userId" | "workspaceId" | "platform">;
  update: Prisma.SocialConnectionUncheckedUpdateManyInput;
}): Promise<SaveConnectionResult> {
  const where = { workspaceId_platform: { workspaceId, platform } };
  const incoming = { platform, accountIdentifier: create.accountIdentifier, metadata: create.metadata, accessToken: create.accessToken };
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const existing = await prisma.socialConnection.findUnique({
      where,
      select: { id: true, updatedAt: true, platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
    });
    if (!existing) {
      try {
        await prisma.socialConnection.create({ data: { userId, workspaceId, platform, ...create } });
        return { ok: true };
      } catch (error) {
        // Another sign-in made the row meanwhile: compare against it.
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    const connectedName = connectedAccountName(toConnectionSummary(existing));
    let data = update;
    let locationCleared: string | undefined;
    if (platform === Platform.google_business_profile) {
      // R6 third review: never refused as another account. The new token is
      // saved in place; a location it can't use is cleared for the chooser.
      const location = await checkGbpLocation(existing, create.accessToken);
      if (location === "check_failed") return { ok: false, reason: "check_failed", connectedName };
      if (location === "unavailable") {
        const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
        locationCleared = typeof metadata.locationTitle === "string" ? metadata.locationTitle : "";
        data = {
          ...update,
          metadata: { ...metadata, locationName: null, locationTitle: null } as Prisma.InputJsonValue,
        };
      }
    } else if (!sameAccount(existing, incoming)) {
      return {
        ok: false,
        reason: "different_account",
        connectedName,
        signedInName: signedInName?.trim() || `a different ${platformLabel(platform)} account`,
      };
    }
    const { count } = await prisma.socialConnection.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data,
    });
    if (count === 1) return locationCleared === undefined ? { ok: true } : { ok: true, locationCleared };
    // The row changed after it was compared: read it again.
  }
  throw new Error("The connection kept changing while it was being saved.");
}

export interface FacebookPageAccount {
  id: string;
  name: string;
  /** The Page access token from /me/accounts. */
  accessToken: string;
}

export async function saveFacebookPageConnection({
  userId,
  workspaceId,
  page,
  expiresAt,
}: ConnectionOwner & { page: FacebookPageAccount; expiresAt: Date }): Promise<SaveConnectionResult> {
  const fields = {
    accessToken: page.accessToken,
    refreshToken: null,
    expiresAt,
    accountIdentifier: page.id,
    metadata: {
      pageName: page.name,
    },
    ...HEALTHY,
  };

  return saveSocialConnection({
    userId,
    workspaceId,
    platform: Platform.facebook_page,
    signedInName: page.name,
    create: fields,
    update: fields,
  });
}

export interface InstagramAccountDetails {
  username: string;
  profilePicture: string | null;
}

/**
 * The Instagram account's username and picture, read with the linked Page's
 * token. `null` when Graph answers with an error (logged; it never holds the
 * token). A network failure throws.
 */
export async function fetchInstagramAccountDetails(
  igAccountId: string,
  pageAccessToken: string,
): Promise<InstagramAccountDetails | null> {
  const igUrl = new URL(`${META_GRAPH_BASE_URL}/${igAccountId}`);
  igUrl.searchParams.set("fields", "username,profile_picture_url");
  igUrl.searchParams.set("access_token", pageAccessToken);

  const igResponse = await fetch(igUrl.toString());
  if (!igResponse.ok) {
    const errorText = await igResponse.text();
    console.error("[Instagram OAuth] Failed to fetch IG account:", errorText);
    return null;
  }

  const igData = (await igResponse.json()) as {
    username: string;
    profile_picture_url?: string;
  };

  return {
    username: igData.username,
    profilePicture: igData.profile_picture_url || null,
  };
}

export async function saveInstagramConnection({
  userId,
  workspaceId,
  igAccountId,
  pageId,
  pageAccessToken,
  details,
  expiresAt,
}: ConnectionOwner & {
  igAccountId: string;
  /** The Facebook Page the Instagram account is linked to. */
  pageId: string;
  pageAccessToken: string;
  details: InstagramAccountDetails;
  expiresAt: Date;
}): Promise<SaveConnectionResult> {
  const fields = {
    accessToken: pageAccessToken,
    refreshToken: null,
    expiresAt,
    accountIdentifier: igAccountId,
    metadata: {
      username: details.username,
      profilePicture: details.profilePicture,
      pageId,
    },
    ...HEALTHY,
  };

  return saveSocialConnection({
    userId,
    workspaceId,
    platform: Platform.instagram,
    signedInName: details.username ? `@${details.username}` : null,
    create: fields,
    update: fields,
  });
}

/** The member token from LinkedIn's code exchange. */
export interface LinkedInToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope?: string | null;
}

export interface LinkedInProfile {
  sub: string;
  name: string;
  email: string | null;
  picture: string | null;
}

/** A company page the member administers. LinkedIn's ids may be numbers. */
export interface LinkedInOrganization {
  id?: string;
  name?: string;
  vanityName?: string | null;
}

/**
 * Saves the LinkedIn connection that posts to `organization`. It is stored as
 * the only entry of `metadata.organizations`: linkedinClient.ts posts as
 * `organizations[0]`.
 */
export async function saveLinkedInConnection({
  userId,
  workspaceId,
  token,
  profile,
  organization,
}: ConnectionOwner & {
  token: LinkedInToken;
  profile: LinkedInProfile;
  organization: LinkedInOrganization;
}): Promise<SaveConnectionResult> {
  const organizations = [organization];
  const fields = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scope || LINKEDIN_SCOPES.join(" "),
    metadata: {
      name: profile.name,
      email: profile.email,
      picture: profile.picture,
      organizations,
      // Shown as "Connected as <page>" in Settings (lib/connectionSummary.ts):
      // the company page posts go to, not a placeholder member id.
      username: organizations[0]?.name ?? null,
      // When the page's name was read: LinkedIn allows eight weeks for it
      // (server/connections/linkedinData.ts refreshes or deletes it daily).
      organizationsFetchedAt: new Date().toISOString(),
    } as unknown as Prisma.InputJsonValue,
    ...HEALTHY,
  };

  return saveSocialConnection({
    userId,
    workspaceId,
    platform: Platform.linkedin,
    signedInName: organization.name ?? null,
    create: { ...fields, accountIdentifier: profile.sub },
    update: fields,
  });
}

/** The tokens from Pinterest's code exchange. */
export interface PinterestToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  /** The scopes Pinterest granted. */
  scopes: string[];
}

/**
 * Saves the Pinterest connection that posts to `board` (2026-11-10). A Pin
 * always goes on a board, so the board is part of the connection:
 * pinterestClient.ts reads `metadata.boardId`, and Settings shows the username
 * with the board's name (lib/connectionSummary.ts). To post to another board
 * the user connects again and chooses it.
 */
export async function savePinterestConnection({
  userId,
  workspaceId,
  token,
  account,
  board,
}: ConnectionOwner & {
  token: PinterestToken;
  account: PinterestAccount;
  board: PinterestBoard;
}): Promise<SaveConnectionResult> {
  const fields = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    accountIdentifier: account.username,
    scopes: token.scopes,
    metadata: {
      username: account.username,
      accountId: account.id,
      accountType: account.accountType,
      boardId: board.id,
      boardName: board.name,
    },
    ...HEALTHY,
  };

  return saveSocialConnection({
    userId,
    workspaceId,
    platform: Platform.pinterest,
    signedInName: account.username,
    create: fields,
    update: fields,
  });
}
