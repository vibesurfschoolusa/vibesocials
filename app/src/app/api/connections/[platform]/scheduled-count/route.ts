import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";

import { APPROVAL_DECIDABLE_STATUSES } from "@/lib/approval";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getWorkspaceContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { signedOutResponse } from "@/lib/signedOutResponse";

interface PlatformRouteContext {
  params: Promise<{ platform: string }> | { platform: string };
}

/**
 * GET /api/connections/[platform]/scheduled-count?workspaceId=... (R5 pages M1)
 *
 * How many scheduled posts chose this platform, for the Disconnect dialog: at
 * publish time each of them gets a failed "not connected" result on it
 * (server/jobs/posting.ts CONNECTION_GONE). A Feed and Story post counts
 * once. R61 pages-a-2 L1: a post waiting for approval with a time counts
 * too (dashboard/summary's AWAITING_APPROVAL): it keeps its time and
 * platforms, and once approved it fails the same way. The answer stays
 * `{ count }`, so an open page keeps reading it. `workspaceId` is the workspace the Settings page was rendered for
 * (F3), so a stale tab never shows another workspace's number. Read-only and
 * member-readable, like GET /api/connections/[platform].
 */
export async function GET(request: NextRequest, context: PlatformRouteContext) {
  const wsContext = await getWorkspaceContext();
  if (!wsContext) {
    return signedOutResponse();
  }

  const sent = request.nextUrl.searchParams.get("workspaceId");
  const refusal = renderedWorkspaceRefusal(sent ?? undefined, wsContext.workspace.id);
  if (refusal) {
    return refusal;
  }

  const { platform } = await Promise.resolve(context.params);
  if (!(Object.values(Platform) as string[]).includes(platform)) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  try {
    const jobs = await prisma.postJob.findMany({
      where: {
        workspaceId: wsContext.workspace.id,
        OR: [
          { status: "scheduled" },
          {
            status: { in: [...APPROVAL_DECIDABLE_STATUSES] },
            submittedForApprovalAt: { not: null },
            approvedAt: null,
            scheduledFor: { not: null },
          },
        ],
        publishMetadata: { path: ["targetPlatforms"], array_contains: [platform] },
      },
      select: { id: true, storyOfPostJobId: true },
    });
    const listed = new Set(jobs.map((job) => job.id));
    // A Story half whose feed post is also listed is the same post.
    const count = jobs.filter((job) => !job.storyOfPostJobId || !listed.has(job.storyOfPostJobId)).length;
    return NextResponse.json({ count });
  } catch (error) {
    logger.error("[GET /api/connections/[platform]/scheduled-count] Unexpected error", {
      error,
      workspaceId: wsContext.workspace.id,
      platform,
    });
    return NextResponse.json(
      { error: "We couldn't count the scheduled posts. Close the dialog and open it again to retry." },
      { status: 500 },
    );
  }
}
