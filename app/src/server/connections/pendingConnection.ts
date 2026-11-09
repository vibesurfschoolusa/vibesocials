import { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";

import {
  fetchInstagramAccountDetails,
  saveFacebookPageConnection,
  saveInstagramConnection,
  saveLinkedInConnection,
  type FacebookPageAccount,
  type LinkedInOrganization,
  type LinkedInProfile,
} from "./saveConnection";

/**
 * Choosing which account to connect (2026-11-09).
 *
 * When a Facebook, Instagram or LinkedIn connect finds several accounts the
 * user manages, the OAuth callback connects none of them. It stores the
 * candidates here (with the tokens needed to connect any one of them, sealed)
 * and sends the user to `/settings?choose=<id>`, where they pick one.
 *
 * A pending row belongs to the user who started the connect, in the workspace
 * it was started for, and lives 15 minutes. Starting another connect for the
 * same platform replaces it.
 */

export const PENDING_CONNECTION_TTL_MS = 15 * 60 * 1000;

/** The platforms whose connect can end in a choice. */
export type ChoosablePlatform = "facebook_page" | "instagram" | "linkedin";

export interface InstagramAccountCandidate {
  igAccountId: string;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  /** Read at connect time for the list; null when Graph didn't answer. */
  username: string | null;
}

/** What a pending row's sealed payload holds, per platform. */
export type PendingConnectionPayload =
  | {
      platform: "facebook_page";
      /** ISO time the user token (and so the Page tokens) expire. */
      expiresAt: string;
      pages: FacebookPageAccount[];
    }
  | {
      platform: "instagram";
      expiresAt: string;
      accounts: InstagramAccountCandidate[];
    }
  | {
      platform: "linkedin";
      token: {
        accessToken: string;
        refreshToken: string | null;
        expiresAt: string;
        scope: string | null;
      };
      profile: LinkedInProfile;
      organizations: LinkedInOrganization[];
    };

/** One account the user can choose. Safe for the browser: no tokens. */
export interface PendingCandidate {
  id: string;
  name: string;
  detail?: string;
}

export interface LoadedPendingConnection {
  id: string;
  platform: ChoosablePlatform;
  payload: PendingConnectionPayload;
}

/**
 * Stores a connect that is waiting for the user's choice and returns its id.
 * Replaces any earlier pending connect this user started for the same
 * platform in this workspace, and drops this user's expired rows here.
 */
export async function createPendingConnection({
  workspaceId,
  userId,
  payload,
}: {
  workspaceId: string;
  userId: string;
  payload: PendingConnectionPayload;
}): Promise<string> {
  const now = Date.now();
  const platform = payload.platform as Platform;

  const [, created] = await prisma.$transaction([
    prisma.pendingConnection.deleteMany({
      where: {
        workspaceId,
        userId,
        OR: [{ platform }, { expiresAt: { lte: new Date(now) } }],
      },
    }),
    prisma.pendingConnection.create({
      data: {
        workspaceId,
        userId,
        platform,
        payload: sealSecret(JSON.stringify(payload)),
        expiresAt: new Date(now + PENDING_CONNECTION_TTL_MS),
      },
      select: { id: true },
    }),
  ]);

  return created.id;
}

function isChoosablePlatform(platform: Platform): platform is ChoosablePlatform {
  return platform === "facebook_page" || platform === "instagram" || platform === "linkedin";
}

/**
 * The pending connect `id`, if it exists, hasn't expired, and was started by
 * `userId` in `workspaceId`; otherwise null. An expired (or unreadable) row of
 * the caller's is deleted on the way.
 */
export async function loadPendingConnection(
  id: string,
  owner: { workspaceId: string; userId: string },
): Promise<LoadedPendingConnection | null> {
  const row = await prisma.pendingConnection.findUnique({ where: { id } });
  if (!row || row.workspaceId !== owner.workspaceId || row.userId !== owner.userId) {
    return null;
  }

  if (row.expiresAt.getTime() <= Date.now() || !isChoosablePlatform(row.platform)) {
    await deletePendingConnection(row.id);
    return null;
  }

  let payload: PendingConnectionPayload;
  try {
    payload = JSON.parse(openSecret(row.payload)) as PendingConnectionPayload;
  } catch (error) {
    // Wrong key or a corrupt row: it can never be used, so drop it. The error
    // kind only — a parse error message would quote the (token-bearing) text.
    logger.warn("[PendingConnection] Could not read a pending connection; deleting it", {
      pendingConnectionId: row.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    await deletePendingConnection(row.id);
    return null;
  }

  if (payload?.platform !== row.platform) {
    await deletePendingConnection(row.id);
    return null;
  }

  return { id: row.id, platform: row.platform, payload };
}

export async function deletePendingConnection(id: string): Promise<void> {
  // deleteMany: a row that is already gone (a double click, a parallel
  // request) is not an error.
  await prisma.pendingConnection.deleteMany({ where: { id } });
}

/** The accounts to choose from: ids and names only, never tokens. */
export function listPendingCandidates(payload: PendingConnectionPayload): PendingCandidate[] {
  switch (payload.platform) {
    case "facebook_page":
      return payload.pages.map((page) => ({ id: page.id, name: page.name }));
    case "instagram":
      return payload.accounts.map((account) => ({
        id: account.igAccountId,
        name: account.pageName,
        ...(account.username ? { detail: `@${account.username}` } : {}),
      }));
    case "linkedin":
      return payload.organizations.map((org) => ({
        id: String(org.id),
        name: org.name ?? String(org.id),
        ...(org.vanityName ? { detail: `linkedin.com/company/${org.vanityName}` } : {}),
      }));
  }
}

export type ConnectPendingResult =
  | { ok: true }
  /** `candidateId` is not one of this pending connect's accounts. */
  | { ok: false; reason: "unknown_candidate" }
  /** The platform wouldn't describe the chosen account (Instagram only). */
  | { ok: false; reason: "provider_failed" };

/**
 * Connects the chosen account exactly as the OAuth callback connects a lone
 * one. Leaves the pending row alone; the caller deletes it on success.
 */
export async function connectPendingCandidate(
  pending: LoadedPendingConnection,
  candidateId: string,
  owner: { workspaceId: string; userId: string },
): Promise<ConnectPendingResult> {
  const { payload } = pending;

  switch (payload.platform) {
    case "facebook_page": {
      const page = payload.pages.find((p) => p.id === candidateId);
      if (!page) return { ok: false, reason: "unknown_candidate" };

      await saveFacebookPageConnection({
        ...owner,
        page,
        expiresAt: new Date(payload.expiresAt),
      });
      return { ok: true };
    }

    case "instagram": {
      const account = payload.accounts.find((a) => a.igAccountId === candidateId);
      if (!account) return { ok: false, reason: "unknown_candidate" };

      const details = await fetchInstagramAccountDetails(
        account.igAccountId,
        account.pageAccessToken,
      );
      if (!details) return { ok: false, reason: "provider_failed" };

      await saveInstagramConnection({
        ...owner,
        igAccountId: account.igAccountId,
        pageId: account.pageId,
        pageAccessToken: account.pageAccessToken,
        details,
        expiresAt: new Date(payload.expiresAt),
      });
      return { ok: true };
    }

    case "linkedin": {
      const organization = payload.organizations.find((org) => String(org.id) === candidateId);
      if (!organization) return { ok: false, reason: "unknown_candidate" };

      await saveLinkedInConnection({
        ...owner,
        token: {
          accessToken: payload.token.accessToken,
          refreshToken: payload.token.refreshToken,
          expiresAt: new Date(payload.token.expiresAt),
          scope: payload.token.scope,
        },
        profile: payload.profile,
        organization,
      });
      return { ok: true };
    }
  }
}
