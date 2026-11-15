import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { CONNECTION_EXPIRY_SELECT, connectionExpiryState, type ConnectionExpiryState } from "@/lib/connectionExpiry";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Platform } from "@prisma/client";
import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";
import { signedOutResponse } from "@/lib/signedOutResponse";

/**
 * GET /api/connections
 *
 * Additive, read-only summary powering the dashboard "connection health" row.
 * Reports, for every platform this deployment offers, whether the active WORKSPACE has a
 * connection (Team Workspaces — connections are shared by every member,
 * design §1/§4: "View connection health" is member-readable) — without
 * exposing any connection details. Complements the existing per-platform
 * `GET /api/connections/[platform]` in a single request.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return signedOutResponse();
  }

  try {
    const rows = await prisma.socialConnection.findMany({
      where: { workspaceId: context.workspace.id },
      // Roadmap Phase 4: needsReconnect is the connection-health flag itself
      // (see server/platforms/connectionHealth.ts) — still never accessToken/
      // scopes/metadata. R7-pages L4: the expiry columns too, for the warning
      // window; the refresh token is only tested for presence, here, and
      // never leaves the server.
      select: CONNECTION_EXPIRY_SELECT,
    });

    const now = new Date();
    const reconnectByPlatform = new Map(
      rows.map((row) => [row.platform, row.needsReconnect]),
    );
    const expiryByPlatform = new Map<Platform, ConnectionExpiryState>(
      rows.map((row) => [row.platform, connectionExpiryState(row, now)]),
    );
    // A platform this deployment can't connect yet (Pinterest before its app
    // credentials are set, lib/advertisedPlatforms.ts) is listed only when the
    // workspace already has that connection.
    const offered = new Set<Platform>(advertisedPlatforms());
    const connections: ConnectionStatus[] = (Object.values(Platform) as Platform[])
      .filter((platform) => offered.has(platform) || reconnectByPlatform.has(platform))
      .map((platform) => ({
        platform,
        connected: reconnectByPlatform.has(platform),
        needsReconnect: reconnectByPlatform.get(platform) ?? false,
        expiry: expiryByPlatform.get(platform) ?? null,
      }));

    const payload: ConnectionsResponse = { connections };
    return NextResponse.json(payload);
  } catch (error: unknown) {
    logger.error("[GET /api/connections] Unexpected error", {
      error,
      workspaceId: context.workspace.id,
    });
    return NextResponse.json(
      { error: "Failed to load connections" },
      { status: 500 },
    );
  }
}
