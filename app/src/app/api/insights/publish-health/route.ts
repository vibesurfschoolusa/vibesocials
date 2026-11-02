import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { summarizePublishHealthCounts, type PublishHealthSummary } from "@/lib/publishHealth";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Window the dashboard card reports on. */
export const PUBLISH_HEALTH_WINDOW_DAYS = 30;

export interface PublishHealthResponse extends PublishHealthSummary {
  windowDays: number;
}

/**
 * GET /api/insights/publish-health — per-platform publish success rates for the
 * active workspace over the last {@link PUBLISH_HEALTH_WINDOW_DAYS} days.
 *
 * Reads PostJobResult rows the app already writes, so it covers EVERY platform
 * (PostMetric is YouTube-only today) and calls no provider API. Any member may
 * read it: this is workspace health, the same access level as the activity feed.
 *
 * 2026-11-01 scale audit (db M5, web W16): one grouped COUNT over
 * PostJobResult.workspaceId (denormalized from the job; index
 * [workspaceId, updatedAt]) instead of loading rows through a PostJob join, so
 * the cost no longer scales with the workspace's history and the counts are
 * exact for any tenant (there is no row cap). `updatedAt` is still the moment a
 * result finished, which is why no backfill or heal may move it.
 *
 * SEC-1: groups only on platform and status — errorCode, socialConnectionId and
 * externalPostId are never read.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - PUBLISH_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const groups = await prisma.postJobResult.groupBy({
    by: ["platform", "status"],
    where: {
      workspaceId: context.workspace.id,
      status: { in: ["success", "failed"] },
      updatedAt: { gte: since },
    },
    _count: { _all: true },
  });

  const summary = summarizePublishHealthCounts(
    groups.map((group) => ({
      platform: group.platform,
      status: group.status,
      count: group._count._all,
    })),
  );

  const payload: PublishHealthResponse = {
    ...summary,
    windowDays: PUBLISH_HEALTH_WINDOW_DAYS,
  };

  return NextResponse.json(payload);
}
