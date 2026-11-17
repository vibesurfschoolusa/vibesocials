import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { withoutPairedStories } from "@/lib/countOnce";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { getWorkspaceContext } from "@/lib/workspace";
import { APPROVAL_DECIDABLE_STATUSES } from "@/lib/approval";
import { planIncludes } from "@/lib/planFeatures";
import type { DashboardSummary } from "@/lib/needsYou";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { renderedWorkspaceRefusal, sentWorkspaceId } from "@/lib/workspaceChanged";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A draft or scheduled post a client asked to change (the review link sets the time). */
const CLIENT_CHANGE_REQUESTED: Prisma.PostJobWhereInput = {
  status: { in: ["draft", "scheduled"] },
  clientChangeRequestedAt: { not: null },
};

/**
 * Posts matching `where`, a Feed and Story pair counted once by the shared rule
 * (lib/countOnce.ts): it is one post to the owner, as the Queue's one card
 * shows it. Only the matching Story jobs and the feed jobs they name are read,
 * a handful at most. R2-client-journey L1 (client changes), R3-client-journey
 * L1 (posts that did not fully go out) and M1 (held posts) all count this way.
 */
async function countPostsOnce(workspaceId: string, where: Prisma.PostJobWhereInput): Promise<number> {
  const pairSelect = { id: true, storyOfPostJobId: true } as const;
  const [matching, stories] = await Promise.all([
    prisma.postJob.count({ where: { workspaceId, ...where } }),
    prisma.postJob.findMany({
      where: { workspaceId, ...where, storyOfPostJobId: { not: null } },
      select: pairSelect,
    }),
  ]);
  const feedIds = [...new Set(stories.map((story) => story.storyOfPostJobId).filter((id): id is string => id !== null))];
  if (feedIds.length === 0) return matching;
  const feeds = await prisma.postJob.findMany({
    where: { workspaceId, ...where, id: { in: feedIds } },
    select: pairSelect,
  });
  const pairRows = [...feeds, ...stories];
  return matching - (pairRows.length - withoutPairedStories(pairRows).length);
}

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
export async function GET(request: Request) {
  const context = await getWorkspaceContext();
  if (!context) {
    return signedOutResponse();
  }

  // R32 publishing L1: the page's workspace, so a dashboard left on another one never counts this one's posts.
  const workspaceRefusal = renderedWorkspaceRefusal(sentWorkspaceId(request), context.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "dashboard/summary",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit);
  }

  const workspaceId = context.workspace.id;
  const now = new Date();
  const isOwner = context.role === "owner";

  const [problemsLast7Days, awaitingYourApproval, clientChangesRequested, next, google] = await Promise.all([
    countPostsOnce(workspaceId, {
      // updatedAt, not createdAt: a post scheduled weeks ago that failed this
      // week is a problem of this week.
      updatedAt: { gte: new Date(now.getTime() - WEEK_MS) },
      status: { not: "cancelled" },
      OR: [{ status: "failed" }, { results: { some: { status: "failed" } } }],
    }),
    isOwner ? countPostsOnce(workspaceId, AWAITING_APPROVAL) : Promise.resolve(null),
    countPostsOnce(workspaceId, CLIENT_CHANGE_REQUESTED),
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
    // F4: a Google listing connected without a location (a client's connect
    // link always does that) fails every Google post until an owner picks one.
    isOwner
      ? prisma.socialConnection.findFirst({
          where: { workspaceId, platform: "google_business_profile" },
          select: { metadata: true },
        })
      : Promise.resolve(null),
  ]);
  const locationName = (google?.metadata as { locationName?: unknown } | null | undefined)?.locationName;
  const chooseGoogleLocation =
    google && !(typeof locationName === "string" && locationName.trim()) ? context.workspace.name : null;

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
    chooseGoogleLocation,
    // R5-new-customer L6: Needs you offers Add many only where the plan includes it.
    addManyIncluded: planIncludes(context.workspace, "bulk"),
  };
  return NextResponse.json(body);
}
