import { NextRequest, NextResponse } from "next/server";

import { getWorkspaceContext, requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { Platform } from "@prisma/client";
import { signedOutResponse } from "@/lib/signedOutResponse";

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
    return signedOutResponse();
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
 *
 * Publish history survives: PostJobResult.socialConnectionId is `onDelete:
 * SetNull` (2026-11-01 audit), so Activity / Publish health keep every past
 * result — they just no longer point at a connection.
 *
 * The body carries `{ workspaceId }`, the workspace the Settings page was
 * rendered for (F3): the active workspace is one cookie for every tab, so a
 * Disconnect or Switch account in a stale tab must not remove another
 * workspace's account.
 */
export async function DELETE(request: NextRequest, context: PlatformRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const { workspace } = contextOrError;

  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, workspace.id);
  if (refusal) {
    return refusal;
  }

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
    // Disconnecting deletes the numbers read through the connection, in the
    // same transaction (YouTube API Services policy 2026-11-09, and F3 for
    // every platform): the workspace's post numbers for the platform (one
    // connection per platform per workspace, so they are this connection's)
    // and, for Google Business Profile, the listing's daily numbers, which
    // are only ever read through the workspace's one GBP connection.
    const [result] = await prisma.$transaction([
      prisma.socialConnection.deleteMany({ where: { workspaceId: workspace.id, platform } }),
      prisma.postMetric.deleteMany({ where: { workspaceId: workspace.id, platform } }),
      ...(platform === Platform.google_business_profile
        ? [prisma.locationMetricDaily.deleteMany({ where: { workspaceId: workspace.id } })]
        : []),
    ]);

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
