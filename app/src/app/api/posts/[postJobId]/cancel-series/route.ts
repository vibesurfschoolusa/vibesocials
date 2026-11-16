import { NextResponse, type NextRequest } from "next/server";
import type { PostJobStatus } from "@prisma/client";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { cancelData } from "@/lib/approval";
import { checkRateLimit } from "@/lib/rateLimit";
import { POST_GONE_TEXT, postMovedOnText } from "@/lib/postMovedOn";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";
import { finishPostJob } from "@/server/jobs/failPendingResults";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { readJsonObject } from "@/lib/http";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";

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
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return signedOutResponse();
  }

  // No pause check: cancelling only stops work, so it stays allowed while the
  // workspace is paused, like the single cancel.

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
  // R31 pages L2: the page's workspace, so a tab left on another workspace acts on nothing.
  const workspaceRefusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, workspaceId);
  if (workspaceRefusal) return workspaceRefusal;

  // R31 publishing L1: what happened to this post (postMovedOnText), and that
  // the later posts of the series were not touched, so nobody thinks they went.
  const notCancelable = (status: PostJobStatus | null | undefined) =>
    NextResponse.json(
      {
        error: `${postMovedOnText(status, "cancelled") ?? "This post can no longer be cancelled."} The later posts in this series were left as they are: cancel them on their own cards.`,
        code: "NOT_CANCELABLE",
      },
      { status: 409 },
    );

  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: { status: true, scheduledFor: true, seriesId: true },
  });

  if (!job) {
    return NextResponse.json({ error: POST_GONE_TEXT }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status)) {
    return notCancelable(job.status);
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

  // One transaction, each post with its own condition. finishPostJob also
  // stamps each cancelled post's media as used now, as the single cancel does,
  // so the retention sweep counts its 30 days from here.
  const cancelled = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const post of posts) {
      count += await finishPostJob(tx, {
        where: {
          id: post.id,
          workspaceId,
          status: { in: [...MUTABLE_POST_JOB_STATUSES] },
          submittedForApprovalAt: post.submittedForApprovalAt,
          approvedAt: post.approvedAt,
        },
        data: cancelData(post),
      });
    }
    return count;
  });
  if (cancelled === 0) {
    // Lost every race (the scanner claimed them): read this post again, for the sentence only.
    const now = await prisma.postJob.findFirst({ where: { id: postJobId, workspaceId }, select: { status: true } });
    return notCancelable(now?.status);
  }

  return NextResponse.json(
    { ok: true, cancelled, notCancelled: posts.length - cancelled },
    { status: 200 },
  );
}
