import { Platform, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";
import { LINKEDIN_SCOPES } from "@/lib/oauthScopes";

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
}: ConnectionOwner & { page: FacebookPageAccount; expiresAt: Date }): Promise<void> {
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

  await prisma.socialConnection.upsert({
    where: {
      workspaceId_platform: {
        workspaceId,
        platform: Platform.facebook_page,
      },
    },
    update: fields,
    create: {
      userId,
      workspaceId,
      platform: Platform.facebook_page,
      ...fields,
    },
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
}): Promise<void> {
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

  await prisma.socialConnection.upsert({
    where: {
      workspaceId_platform: {
        workspaceId,
        platform: Platform.instagram,
      },
    },
    update: fields,
    create: {
      userId,
      workspaceId,
      platform: Platform.instagram,
      ...fields,
    },
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
}): Promise<void> {
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

  await prisma.socialConnection.upsert({
    where: {
      workspaceId_platform: {
        workspaceId,
        platform: Platform.linkedin,
      },
    },
    create: {
      userId,
      workspaceId,
      platform: Platform.linkedin,
      ...fields,
      accountIdentifier: profile.sub,
    },
    update: fields,
  });
}
