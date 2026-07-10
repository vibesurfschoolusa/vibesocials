import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";
import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";

/**
 * GET /api/connections
 *
 * Additive, read-only summary powering the dashboard "connection health" row.
 * Reports, for every supported platform, whether the authenticated user has a
 * connection — without exposing any connection details. Complements the
 * existing per-platform `GET /api/connections/[platform]` in a single request.
 */
export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await prisma.socialConnection.findMany({
      where: { userId: user.id },
      // Roadmap Phase 4: needsReconnect is the connection-health flag itself
      // (see server/platforms/connectionHealth.ts) — still never accessToken/
      // refreshToken/scopes/metadata.
      select: { platform: true, needsReconnect: true },
    });

    const reconnectByPlatform = new Map(
      rows.map((row) => [row.platform, row.needsReconnect]),
    );
    const connections: ConnectionStatus[] = (
      Object.values(Platform) as Platform[]
    ).map((platform) => ({
      platform,
      connected: reconnectByPlatform.has(platform),
      needsReconnect: reconnectByPlatform.get(platform) ?? false,
    }));

    const payload: ConnectionsResponse = { connections };
    return NextResponse.json(payload);
  } catch (error: unknown) {
    console.error("[GET /api/connections] Unexpected error", { error });
    return NextResponse.json(
      { error: "Failed to load connections" },
      { status: 500 },
    );
  }
}
