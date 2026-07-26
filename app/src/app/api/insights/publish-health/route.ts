import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { summarizePublishHealth, type PublishHealthSummary } from "@/lib/publishHealth";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Window the dashboard card reports on. */
export const PUBLISH_HEALTH_WINDOW_DAYS = 30;

/** Hard cap so a very busy workspace can't pull an unbounded result set. */
const MAX_ROWS = 2000;

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
 * SEC-1: projects only platform/status/updatedAt into the summary — never
 * errorCode, socialConnectionId or externalPostId.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - PUBLISH_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.postJobResult.findMany({
    where: {
      postJob: { workspaceId: context.workspace.id },
      status: { in: ["success", "failed"] },
      updatedAt: { gte: since },
    },
    select: { platform: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_ROWS,
  });

  const summary = summarizePublishHealth(
    rows.map((row) => ({
      platform: row.platform,
      status: row.status,
      finishedAt: row.updatedAt,
    })),
    now,
    PUBLISH_HEALTH_WINDOW_DAYS,
  );

  const payload: PublishHealthResponse = {
    ...summary,
    windowDays: PUBLISH_HEALTH_WINDOW_DAYS,
  };

  return NextResponse.json(payload);
}
