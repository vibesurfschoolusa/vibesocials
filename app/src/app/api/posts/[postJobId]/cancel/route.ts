import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { cancelData } from "@/lib/approval";
import { readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";
import { finishPostJob } from "@/server/jobs/failPendingResults";

import { findPairHalf, type PairHalf } from "./pairHalf";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/**
 * Generous throttle for the queue mutation endpoints (cancel/edit/delete).
 * They're DB-only with no external cost — unlike posts/publish — so the limit is
 * high; it exists only so a runaway client can't hammer the DB, matching the
 * "every guarded route" convention (review Minor #2).
 */
const MUTATE_RATE_LIMIT = { route: "posts/mutate", limit: 60, windowMs: 5 * 60 * 1000 } as const;

/**
 * POST /api/posts/[postJobId]/cancel — Roadmap Phase 5 (§6.2).
 *
 * Cancel a scheduled or draft post. A plain DB update — there is no Inngest run
 * to tear down (the cron simply never claims a `cancelled` job), so cancel is
 * race-free. Auth + ownership scoped. Only `scheduled`/`draft` may be cancelled;
 * a job already `in_progress`/terminal returns 409.
 *
 * The guard is a single ATOMIC conditional `updateMany` (id + workspace +
 * status in the cancelable set): if the cron claims the job (scheduled →
 * in_progress) at the same instant, exactly one of the two updates wins — the
 * cancel then sees count === 0 and 409s rather than cancelling a post that
 * already went live.
 *
 * Approval (2026-11-01 audit): cancelling a post that is awaiting approval is
 * the member WITHDRAWING it — owners reject through the approval route — so
 * the same write also clears `submittedForApprovalAt` (`cancelData`), and the
 * post reads back as approval state "none" rather than "rejected". The write is
 * pinned to the approval columns it was decided from, so a submission or
 * decision landing mid-request 409s instead of being mislabelled.
 *
 * R2-client-journey M1: a "Feed and Story" post is two jobs. With the
 * optional body `{ includePair: true }` the same request then cancels the
 * other half too, read in this workspace and written with the same pinned,
 * conditional update, and the answer's `pair` says what happened to it:
 * "cancelled", "not_cancelable" (it had started publishing, or changed
 * mid-request) or "none" (no live other half). Without the option the answer
 * is unchanged and the other half is never read.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await mutateRateLimited(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);
  // The body is optional: no body, or one that is not an object, cancels this post alone.
  const includePair = ((await readJsonObject(request)) ?? {}).includePair === true;

  const notCancelable = () =>
    NextResponse.json(
      {
        error: "Only scheduled or draft posts can be cancelled.",
        code: "NOT_CANCELABLE",
      },
      { status: 409 },
    );

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1 — cancel is unrestricted by role). A job in another
  // workspace doesn't match and 404s like "doesn't exist" (no 403 oracle).
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: { id: true, status: true, submittedForApprovalAt: true, approvedAt: true, storyOfPostJobId: true },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status)) {
    return notCancelable();
  }

  // finishPostJob also stamps the post's media as used now, so the retention
  // sweep counts its 30 days from the cancel (review round 2, item 6).
  const count = await finishPostJob(prisma, {
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
      submittedForApprovalAt: job.submittedForApprovalAt,
      approvedAt: job.approvedAt,
    },
    data: cancelData(job),
  });

  if (count === 0) {
    return notCancelable();
  }

  if (!includePair) {
    return NextResponse.json({ ok: true, status: "cancelled" }, { status: 200 });
  }

  let pair: "cancelled" | "not_cancelable" | "none";
  try {
    const pairHalf = await findPairHalf(prisma, workspaceContext.workspace.id, job);
    pair = pairHalf ? await cancelPairHalf(workspaceContext.workspace.id, pairHalf) : "none";
  } catch (error) {
    // This post is cancelled either way; the answer says the other half was not.
    logger.error("[POST /api/posts/[postJobId]/cancel] Couldn't cancel the other half of the post", {
      error,
      postJobId,
    });
    pair = "not_cancelable";
  }
  return NextResponse.json({ ok: true, status: "cancelled", pair }, { status: 200 });
}

/** The other half, cancelled exactly like this post: scoped, cancelable, pinned to what was read. */
async function cancelPairHalf(workspaceId: string, half: PairHalf): Promise<"cancelled" | "not_cancelable"> {
  if (!MUTABLE_POST_JOB_STATUSES.includes(half.status)) return "not_cancelable";
  const count = await finishPostJob(prisma, {
    where: {
      id: half.id,
      workspaceId,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
      submittedForApprovalAt: half.submittedForApprovalAt,
      approvedAt: half.approvedAt,
    },
    data: cancelData(half),
  });
  return count === 1 ? "cancelled" : "not_cancelable";
}

/** The 429 answer when the caller is over the mutate throttle, else null. */
async function mutateRateLimited(userId: string): Promise<NextResponse | null> {
  const rateLimit = await checkRateLimit({ userId, ...MUTATE_RATE_LIMIT });
  if (rateLimit.allowed) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
  );
}

/**
 * GET /api/posts/[postJobId]/cancel (R2-client-journey M1): the other half of
 * a Feed and Story post, so the Queue's cancel and delete dialogs can name it
 * and its time before offering to include it. `{ pair: null }` when there is
 * no live other half. Any member, this workspace only (404 otherwise).
 */
export async function GET(_request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await mutateRateLimited(workspaceContext.user.id);
  if (limited) return limited;

  const { postJobId } = await Promise.resolve(context.params);
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: { id: true, storyOfPostJobId: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const half = await findPairHalf(prisma, workspaceContext.workspace.id, job);
  return NextResponse.json(
    {
      pair: half
        ? { id: half.id, kind: half.kind, status: half.status, scheduledFor: half.scheduledFor?.toISOString() ?? null }
        : null,
    },
    { status: 200 },
  );
}
