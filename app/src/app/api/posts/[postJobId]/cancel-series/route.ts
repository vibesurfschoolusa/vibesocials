import { NextResponse, type NextRequest } from "next/server";
import type { PostJobStatus } from "@prisma/client";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { cancelData } from "@/lib/approval";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { lostRaceAnswer, POST_GONE_TEXT, postMovedOnText } from "@/lib/postMovedOn";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";
import { finishPostJob } from "@/server/jobs/failPendingResults";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
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
 * batch; one that matches nothing is read again and counted by why: in
 * `notCancelled` when it started publishing, `alreadyCancelled` when someone
 * else cancelled it, `gone` when it was deleted, and `changed` when it is still
 * a draft or scheduled.
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
    return tooManyTriesResponse(rateLimit);
  }

  const { postJobId } = await Promise.resolve(context.params);
  const workspaceId = workspaceContext.workspace.id;
  // R31 pages L2: the page's workspace, so a tab left on another workspace acts on nothing.
  const workspaceRefusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, workspaceId);
  if (workspaceRefusal) return workspaceRefusal;

  // R31 publishing L1: what happened to this post (postMovedOnText), and that
  // the later posts of the series were not touched, so nobody thinks they went.
  const LEFT_ALONE = "The later posts in this series were left as they are: cancel them on their own cards.";
  const notCancelable = (status: PostJobStatus | null | undefined) =>
    NextResponse.json(
      {
        error: `${postMovedOnText(status, "cancelled") ?? "This post can no longer be cancelled."} ${LEFT_ALONE}`,
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
  const missed = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const post of posts) {
      const count = await finishPostJob(tx, {
        where: {
          id: post.id,
          workspaceId,
          status: { in: [...MUTABLE_POST_JOB_STATUSES] },
          submittedForApprovalAt: post.submittedForApprovalAt,
          approvedAt: post.approvedAt,
        },
        data: cancelData(post),
      });
      if (count === 0) ids.push(post.id);
    }
    return ids;
  });
  const cancelled = posts.length - missed.length;
  if (cancelled === 0) {
    // Lost every race (R59 publishing-flow L4: the writes are pinned to the
    // approval fields, so a member's edit sending the post back for approval
    // makes them miss too). This post read again decides (lostRaceAnswer).
    const now = await prisma.postJob.findFirst({ where: { id: postJobId, workspaceId }, select: { status: true } });
    return NextResponse.json(lostRaceAnswer(now, "cancelled", { code: "NOT_CANCELABLE", after: LEFT_ALONE }), { status: 409 });
  }

  // R59 publishing-flow L4: a missed post still draft or scheduled changed in
  // the meantime (`changed`). R60 publishing-flow L3: one a teammate cancelled
  // (`alreadyCancelled`) or deleted (`gone`) at the same moment has its own
  // count, so `notCancelled` holds only posts that started publishing, and a
  // tab reading only that still words it truly.
  const counts = { notCancelled: missed.length, alreadyCancelled: 0, gone: 0, changed: 0 };
  if (missed.length > 0) {
    try {
      const reread = await prisma.postJob.findMany({ where: { id: { in: missed }, workspaceId }, select: { id: true, status: true } });
      counts.changed = reread.filter((post) => MUTABLE_POST_JOB_STATUSES.includes(post.status)).length;
      counts.alreadyCancelled = reread.filter((post) => post.status === "cancelled").length;
      counts.gone = missed.length - reread.length;
      counts.notCancelled = missed.length - counts.changed - counts.alreadyCancelled - counts.gone;
    } catch (error) {
      // The cancel has committed: a count we can't read must not turn it into
      // a 500. Every missed post then reads as notCancelled, the old answer.
      logger.error("[posts] Couldn't count the series posts that changed in the meantime", { error, postJobId });
    }
  }

  return NextResponse.json({ ok: true, cancelled, ...counts }, { status: 200 });
}
