import { NextRequest, NextResponse } from "next/server";

import { getWorkspaceContext, requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Platform } from "@prisma/client";

interface PlatformRouteContext {
  params: Promise<{ platform: string }> | { platform: string };
}

/**
 * GET /api/connections/[platform]
 * Reports whether the active WORKSPACE has a connection for the given
 * platform (Team Workspaces — member-readable, same as the collection GET;
 * design §1: "View connection health" is member-readable). Used by
 * post-creation UI to conditionally show per-platform settings.
 */
export async function GET(_request: NextRequest, context: PlatformRouteContext) {
  const wsContext = await getWorkspaceContext();

  if (!wsContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // In Next.js 15+, params might be a Promise
  const params = await Promise.resolve(context.params);
  const platformParam = params.platform;
  const allPlatforms = Object.values(Platform) as string[];

  if (!allPlatforms.includes(platformParam)) {
    return NextResponse.json({
      error: "Unknown platform",
      received: platformParam,
      expected: allPlatforms,
    }, { status: 400 });
  }

  const platform = platformParam as Platform;

  try {
    const connection = await prisma.socialConnection.findFirst({
      where: {
        workspaceId: wsContext.workspace.id,
        platform,
      },
      select: { id: true },
    });

    return NextResponse.json({ connected: Boolean(connection) });
  } catch (error) {
    logger.error("[GET /api/connections/[platform]] Unexpected error", {
      error,
      workspaceId: wsContext.workspace.id,
      platform: platformParam,
    });
    return NextResponse.json(
      { error: "Failed to check connection status" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/connections/[platform]
 * Disconnects the active workspace's connection for the given platform.
 * Owner-only (Team Workspaces — design §1: "Connect / disconnect / switch
 * platform accounts" is owner-only).
 */
export async function DELETE(_request: NextRequest, context: PlatformRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const { workspace } = contextOrError;

  // In Next.js 15+, params might be a Promise
  const params = await Promise.resolve(context.params);
  const platformParam = params.platform;
  const allPlatforms = Object.values(Platform) as string[];

  console.log('[DELETE /api/connections/[platform]]', {
    platformParam,
    allPlatforms,
    isValid: allPlatforms.includes(platformParam),
  });

  if (!allPlatforms.includes(platformParam)) {
    return NextResponse.json({
      error: "Unknown platform",
      received: platformParam,
      expected: allPlatforms,
    }, { status: 400 });
  }

  const platform = platformParam as Platform;

  try {
    const result = await prisma.socialConnection.deleteMany({
      where: {
        workspaceId: workspace.id,
        platform,
      },
    });

    return NextResponse.json(
      { ok: true, deletedCount: result.count },
      { status: 200 },
    );
  } catch (error) {
    logger.error("[DELETE /api/connections/[platform]] Unexpected error", {
      error,
      workspaceId: workspace.id,
      platform: platformParam,
    });
    return NextResponse.json(
      { error: "Failed to disconnect platform" },
      { status: 500 },
    );
  }
}
