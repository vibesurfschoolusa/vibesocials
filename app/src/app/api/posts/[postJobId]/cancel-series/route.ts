import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { cancelData } from "@/lib/approval";
import { checkRateLimit } from "@/lib/rateLimit";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/** The single cancel's throttle and key, so both buttons share one budget. */
const MUTATE_RATE_LIMIT = { route: "posts/mutate", limit: 60, windowMs: 5 * 60 * 1000 } as const;

/**
 * POST /api/posts/[postJobId]/cancel-series — Repeat (brief 11).
 *
 * "Cancel this and all later posts in the series": every post of this post's
 * series in the active workspace that is still scheduled or a draft and whose
 * time is at or after this one's (this post itself included). Earlier posts,
 * and posts publishing or published, are left alone.
 *
 * The same rules as the single cancel (../cancel/route.ts): any member of the
 * workspace, a post of another workspace 404s, and each post is cancelled by
 * that route's ATOMIC conditional update (id + workspace + a cancelable
 * status, pinned to the approval columns it was read with), so a post the
 * scheduler claims at the same instant is not touched. The updates go in one
 * batch; one that matches nothing is counted in `notCancelled`.
 */
export async function POST(_request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The workspace pause check goes here once it exists, like the other routes that move work.

  const rateLimit = await checkRateLimit({
    userId: workspaceContext.user.id,
    ...MUTATE_RATE_LIMIT,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const { postJobId } = await Promise.resolve(context.params);
  const workspaceId = workspaceContext.workspace.id;

  const notCancelable = () =>
    NextResponse.json(
      {
        error: "Only scheduled or draft posts can be cancelled.",
        code: "NOT_CANCELABLE",
      },
      { status: 409 },
    );

  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: { status: true, scheduledFor: true, seriesId: true },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status)) {
    return notCancelable();
  }

  if (!job.seriesId) {
    return NextResponse.json(
      { error: "This post is not part of a series. Cancel it on its own.", code: "NOT_A_SERIES" },
      { status: 400 },
    );
  }

  // A series has at most 12 posts. This post is named by id as well, so it is
  // included even if its time was cleared.
  const posts = await prisma.postJob.findMany({
    where: {
      workspaceId,
      seriesId: job.seriesId,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
      OR: [{ id: postJobId }, ...(job.scheduledFor ? [{ scheduledFor: { gte: job.scheduledFor } }] : [])],
    },
    select: { id: true, status: true, submittedForApprovalAt: true, approvedAt: true },
  });

  const results = await prisma.$transaction(
    posts.map((post) =>
      prisma.postJob.updateMany({
        where: {
          id: post.id,
          workspaceId,
          status: { in: [...MUTABLE_POST_JOB_STATUSES] },
          submittedForApprovalAt: post.submittedForApprovalAt,
          approvedAt: post.approvedAt,
        },
        data: cancelData(post),
      }),
    ),
  );

  const cancelled = results.reduce((sum, result) => sum + result.count, 0);
  if (cancelled === 0) {
    return notCancelable();
  }

  return NextResponse.json(
    { ok: true, cancelled, notCancelled: posts.length - cancelled },
    { status: 200 },
  );
}
