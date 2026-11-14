import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { APPROVAL_DECIDABLE_STATUSES } from "@/lib/approval";
import type { DashboardSummary } from "@/lib/needsYou";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `lib/approval.ts` isAwaitingApprovalDecision as a query: a draft or scheduled
 * row submitted for approval and never approved (cancelled ones are excluded by
 * the status list, which is how deriveApprovalState tells "rejected" apart).
 */
const AWAITING_APPROVAL: Prisma.PostJobWhereInput = {
  status: { in: [...APPROVAL_DECIDABLE_STATUSES] },
  submittedForApprovalAt: { not: null },
  approvedAt: null,
};

/**
 * GET /api/dashboard/summary: the counts behind the dashboard's "Needs you"
 * card (N1). Any member may read; counts and one findFirst, so the cost does
 * not grow with the number of posts, and nothing but numbers and one time
 * leaves the server.
 */
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "dashboard/summary",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const workspaceId = context.workspace.id;
  const now = new Date();
  const isOwner = context.role === "owner";

  const [problemsLast7Days, awaitingYourApproval, clientChangesRequested, next] = await Promise.all([
    prisma.postJob.count({
      where: {
        workspaceId,
        // updatedAt, not createdAt: a post scheduled weeks ago that failed this
        // week is a problem of this week.
        updatedAt: { gte: new Date(now.getTime() - WEEK_MS) },
        status: { not: "cancelled" },
        OR: [{ status: "failed" }, { results: { some: { status: "failed" } } }],
      },
    }),
    isOwner ? prisma.postJob.count({ where: { workspaceId, ...AWAITING_APPROVAL } }) : Promise.resolve(null),
    prisma.postJob.count({
      where: {
        workspaceId,
        status: { in: ["draft", "scheduled"] },
        clientChangeRequestedAt: { not: null },
      },
    }),
    prisma.postJob.findFirst({
      where: {
        workspaceId,
        status: "scheduled",
        scheduledFor: { gt: now },
        NOT: AWAITING_APPROVAL,
      },
      orderBy: { scheduledFor: "asc" },
      select: { scheduledFor: true, publishMetadata: true },
    }),
  ]);

  let nextScheduled: DashboardSummary["nextScheduled"] = null;
  if (next?.scheduledFor) {
    const targets = (next.publishMetadata as { targetPlatforms?: unknown } | null)?.targetPlatforms;
    // No chosen platforms means "every platform connected at publish time".
    const platformCount =
      Array.isArray(targets) && targets.length > 0
        ? targets.length
        : await prisma.socialConnection.count({ where: { workspaceId } });
    nextScheduled = { scheduledFor: next.scheduledFor.toISOString(), platformCount };
  }

  const body: DashboardSummary = {
    problemsLast7Days,
    awaitingYourApproval,
    clientChangesRequested,
    nextScheduled,
  };
  return NextResponse.json(body);
}
