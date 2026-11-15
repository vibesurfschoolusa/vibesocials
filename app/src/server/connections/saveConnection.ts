import { Platform, Prisma } from "@prisma/client";

import { toConnectionSummary } from "@/lib/connectionSummary";
import { prisma } from "@/lib/db";
import { connectedAccountName } from "@/lib/differentAccount";
import { platformLabel } from "@/lib/platforms";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { LINKEDIN_SCOPES } from "@/lib/oauthScopes";
import type { PinterestBoard } from "@/lib/pinterestApi";
import type { PinterestAccount } from "@/server/connections/pinterestAccount";

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
 * told (an old row without the id), and then the save is not refused.
 *  - LinkedIn: the company page posts go to (`metadata.organizations[0]`),
 *    not the member who signed in.
 *  - YouTube: the channel id (`accountIdentifier` is the channel's title).
 *  - Google Business Profile: the Google account, unless the old placeholder.
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
  if (row.platform === Platform.google_business_profile && row.accountIdentifier === "google_business_profile") {
    return null;
  }
  return row.accountIdentifier || null;
}

export type SaveConnectionResult =
  | { ok: true }
  /** A connection with another account is there; nothing was written. */
  | { ok: false; reason: "different_account"; connectedName: string; signedInName: string };

/**
 * The one save every connect goes through (each OAuth callback, and the
 * account chosen in a waiting choice, in Settings or on /c). R6 review low 1:
 * a sign-in replaces the workspace's connection for that platform only with
 * the same account (connectionAccountKey), on the same row, so its post
 * numbers stay. A different account leaves the row and its tokens as they
 * are; changing account is Switch account, which disconnects first, so there
 * is no row and the new account is simply saved.
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
  update: Prisma.SocialConnectionUncheckedUpdateInput;
}): Promise<SaveConnectionResult> {
  const where = { workspaceId_platform: { workspaceId, platform } };
  const existing = await prisma.socialConnection.findUnique({
    where,
    select: { platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
  });
  if (existing) {
    const stored = connectionAccountKey(existing);
    const incoming = connectionAccountKey({ platform, accountIdentifier: create.accountIdentifier, metadata: create.metadata });
    if (stored !== null && incoming !== null && stored !== incoming) {
      return {
        ok: false,
        reason: "different_account",
        connectedName: connectedAccountName(toConnectionSummary(existing)),
        signedInName: signedInName?.trim() || `a different ${platformLabel(platform)} account`,
      };
    }
  }
  await prisma.socialConnection.upsert({
    where,
    create: { userId, workspaceId, platform, ...create },
    update,
  });
  return { ok: true };
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
