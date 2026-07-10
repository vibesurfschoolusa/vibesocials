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
      select: { platform: true },
    });

    const connectedPlatforms = new Set(rows.map((row) => row.platform));
    const connections: ConnectionStatus[] = (
      Object.values(Platform) as Platform[]
    ).map((platform) => ({
      platform,
      connected: connectedPlatforms.has(platform),
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
