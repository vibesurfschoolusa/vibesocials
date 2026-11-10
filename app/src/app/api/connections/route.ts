import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Platform } from "@prisma/client";
import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await prisma.socialConnection.findMany({
      where: { workspaceId: context.workspace.id },
      // Roadmap Phase 4: needsReconnect is the connection-health flag itself
      // (see server/platforms/connectionHealth.ts) — still never accessToken/
      // refreshToken/scopes/metadata.
      select: { platform: true, needsReconnect: true },
    });

    const reconnectByPlatform = new Map(
      rows.map((row) => [row.platform, row.needsReconnect]),
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
