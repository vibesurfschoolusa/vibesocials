import type { Platform } from "@prisma/client";

import { billingFieldsSelect } from "@/lib/billing";
import { toConnectionSummary, type ConnectionSummary } from "@/lib/connectionSummary";
import { connectLinkPlatformConfigured, isConnectLinkTokenShape } from "@/lib/connectLink";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { isWorkspaceOwner } from "@/lib/workspace";
import { workspaceBlock } from "@/lib/workspaceStatus";

/**
 * Client connect link (2026-11-11), server side: resolving a raw token to the
 * link it names (rule 2) and whether a platform's place in the workspace is
 * free for it (rule 3). Every public route and the callback wrapper go through
 * these; the workspace always comes from the link, never from the request.
 */

export type ActiveConnectLink = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  /** The owner the flow acts as. */
  createdById: string;
  /** What the link offers, as the owner chose it (configuration is checked per use). */
  platforms: Platform[];
  expiresAt: Date;
};

/**
 * The working link a raw token names, or null. Unknown, revoked, expired, a
 * creator who is no longer an owner, and a blocked workspace (paused, or with
 * billing on a trial or plan that ended) all give null, so every caller
 * answers them the same way.
 */
export async function findActiveConnectLink(token: string): Promise<ActiveConnectLink | null> {
  if (!isConnectLinkTokenShape(token)) return null;
  const row = await prisma.workspaceConnectLink.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      workspaceId: true,
      createdById: true,
      platforms: true,
      expiresAt: true,
      revokedAt: true,
      workspace: { select: { name: true, pausedAt: true, pausedReason: true, ...billingFieldsSelect() } },
    },
  });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now() || workspaceBlock(row.workspace)) {
    return null;
  }
  // The flow acts as the creator, so the link dies with their ownership.
  if (!(await isWorkspaceOwner(row.createdById, row.workspaceId))) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace.name,
    createdById: row.createdById,
    platforms: row.platforms,
    expiresAt: row.expiresAt,
  };
}

/** The link lists the platform and this site has its app credentials. */
export function linkOffers(link: Pick<ActiveConnectLink, "platforms">, platform: Platform): boolean {
  return link.platforms.includes(platform) && connectLinkPlatformConfigured(platform);
}

/**
 * A link fills an empty place and never replaces a working account: the place
 * is taken when the workspace has a connection for the platform that does not
 * need reconnecting.
 */
export async function placeTaken(workspaceId: string, platform: Platform): Promise<boolean> {
  const existing = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform } },
    select: { needsReconnect: true },
  });
  return !!existing && !existing.needsReconnect;
}

/**
 * The workspace's connections as the visitor's page may show them: the
 * browser-safe summary Settings uses (names only, never tokens).
 */
export async function listLinkConnections(workspaceId: string): Promise<ConnectionSummary[]> {
  const rows = await prisma.socialConnection.findMany({
    where: { workspaceId },
    select: { platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
  });
  return rows.map(toConnectionSummary);
}
