import { NextResponse, type NextRequest } from "next/server";
import type { PostJobStatus } from "@prisma/client";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { cancelData } from "@/lib/approval";
import { readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { lostRaceAnswer, POST_GONE_TEXT, postMovedOnText } from "@/lib/postMovedOn";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";
import { finishPostJob } from "@/server/jobs/failPendingResults";

import { applyToPair, readPairHalf, wantsPair } from "../pairRule";
import { signedOutResponse } from "@/lib/signedOutResponse";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";

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
 * R3-client-journey M1: with `{ includePair: true }` (a Feed and Story card)
 * the same write also cancels the other half, in one transaction, and the
 * answer's `otherHalf` says what happened to it (pairRule.ts). The answer
 * keeps R2's `pair` string too, for a tab still running the old Queue.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return signedOutResponse();
  }

  const rateLimit = await checkRateLimit({ userId: workspaceContext.user.id, ...MUTATE_RATE_LIMIT });
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit);
  }

  const { postJobId } = await Promise.resolve(context.params);
  const body = await readJsonObject(request);
  // R31 pages L2: the page's workspace, so a tab left on another workspace acts on nothing.
  const workspaceRefusal = renderedWorkspaceRefusal(body?.workspaceId, workspaceContext.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;
  // Without `includePair: true` this post is cancelled alone.
  const includePair = wantsPair(body);

  // R30 publishing L1: a post that moved on says what happened and to check Activity.
  const notCancelable = (status: PostJobStatus | null | undefined) =>
    NextResponse.json(
      {
        error: postMovedOnText(status, "cancelled") ?? "Only scheduled or draft posts can be cancelled.",
        code: "NOT_CANCELABLE",
      },
      { status: 409 },
    );

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1 — cancel is unrestricted by role). A job in another
  // workspace doesn't match and 404s like "doesn't exist" (no 403 oracle).
  const workspaceId = workspaceContext.workspace.id;
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: { id: true, status: true, submittedForApprovalAt: true, approvedAt: true, storyOfPostJobId: true },
  });

  if (!job) {
    // R31 publishing L4: a sentence, never a bare "Not found".
    return NextResponse.json({ error: POST_GONE_TEXT }, { status: 404 });
  }

  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status)) {
    return notCancelable(job.status);
  }

  const half = await readPairHalf(workspaceId, job, includePair);
  const result = await applyToPair({
    main: { ...job, id: postJobId },
    half,
    // finishPostJob also stamps the post's media as used now, so the retention
    // sweep counts its 30 days from the cancel (review round 2, item 6).
    write: async (db, row) =>
      (await finishPostJob(db, {
        where: {
          id: row.id,
          workspaceId,
          status: { in: [...MUTABLE_POST_JOB_STATUSES] },
          submittedForApprovalAt: row.submittedForApprovalAt,
          approvedAt: row.approvedAt,
        },
        data: cancelData(row),
      })) === 1,
    wording: { done: "was cancelled too", verb: "cancelled" },
  });

  if (!result.ok) {
    // Lost the race (the scanner claimed it, or, R58 pages-a-3 L2, an owner
    // approved meanwhile: the write is pinned to the approval fields). The post
    // read again decides the answer (lostRaceAnswer).
    const now = await prisma.postJob.findFirst({ where: { id: postJobId, workspaceId }, select: { status: true } });
    return NextResponse.json(lostRaceAnswer(now, "cancelled", { code: "NOT_CANCELABLE" }), { status: 409 });
  }

  return NextResponse.json(
    {
      ok: true,
      status: "cancelled",
      ...(includePair ? { pair: oldPairAnswer(half, result.pair) } : {}),
      ...(result.pair ? { otherHalf: result.pair } : {}),
    },
    { status: 200 },
  );
}

/**
 * The answer's `pair` string as R2's Queue reads it, for a tab still running
 * that code: "cancelled", "not_cancelable" (it had moved on or changed), or
 * "none" (no other half, or one already cancelled). The new Queue reads
 * `otherHalf`.
 */
function oldPairAnswer(
  half: { status: string } | null,
  report: { changed: boolean } | null,
): "cancelled" | "not_cancelable" | "none" {
  if (!half || half.status === "cancelled") return "none";
  return report?.changed ? "cancelled" : "not_cancelable";
}
