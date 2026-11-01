import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import {
  holdForApprovalData,
  publishApprovalAction,
  submissionScheduledFor,
} from "@/lib/approval";
import {
  EMAIL_VERIFY_REQUIRED_MESSAGE,
  isEmailVerifiedForPublish,
} from "@/lib/emailVerified";
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import { prepareDeferredPostJobDispatch } from "@/server/jobs/posting";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { MUTABLE_POST_JOB_STATUSES, validateScheduledFor } from "@/lib/scheduling";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

interface PublishBody {
  /** Optional ISO-8601 time. Present → schedule the draft; absent → publish now. */
  scheduledFor?: unknown;
}

/**
 * POST /api/posts/[postJobId]/publish — Roadmap Phase 5 (§6.4).
 *
 * Promote a queued post. With a `scheduledFor` it schedules a DRAFT (draft →
 * `scheduled`; the cron picks it up when due). Without one it publishes NOW —
 * accepting a `draft` OR a `scheduled` job (the Queue's "Publish now" on a
 * scheduled post = publish immediately instead of waiting) — materializing its
 * per-platform results from the connections that exist NOW
 * (`prepareDeferredPostJobDispatch`, the §6.3 run-time-result fix) and running
 * the same `post/publish.requested` / `publishToAllPlatforms` path.
 *
 * Auth + ownership scoped, rate-limited (posts/publish — this triggers live
 * publishing). Each state transition is an ATOMIC conditional `updateMany` so a
 * double-click, a concurrent promote, or the cron claiming the same scheduled
 * job can't publish it twice.
 *
 * Approval (2026-11-01 audit): for a MEMBER in a workspace that requires
 * approval, a post no owner approved never goes out from here
 * (`publishApprovalAction`). A post already awaiting approval 409s
 * `AWAITING_APPROVAL`; a plain draft or an unapproved scheduled post is
 * SUBMITTED for approval instead (202 `{ status: "draft", approvalState:
 * "pending" }`, owners emailed, nothing dispatched). Owners are unaffected.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: workspaceContext.user.id,
    route: "posts/publish",
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many posts published recently. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  const { postJobId } = await Promise.resolve(context.params);

  let body: PublishBody = {};
  try {
    // A body is optional (publish-now sends none); tolerate an empty/invalid one.
    body = ((await request.json()) as PublishBody) ?? {};
  } catch {
    body = {};
  }

  const wantsSchedule = body.scheduledFor != null;

  // Ownership + current status in one read; 404 if not in the caller's
  // workspace. Team Workspaces (Task 4): any member may publish (design §1).
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: {
      status: true,
      scheduledFor: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      baseCaption: true,
      updatedAt: true,
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const approvalAction = publishApprovalAction({
    requireApproval: workspaceContext.workspace.requireApproval,
    role: workspaceContext.role,
    job,
  });

  if (approvalAction === "awaiting_approval") {
    return NextResponse.json(
      { code: "AWAITING_APPROVAL", error: "This post is waiting for an owner's approval." },
      { status: 409 },
    );
  }

  // Submit for approval instead of publishing/scheduling. Needs no verified
  // email or connection yet: nothing goes out until an owner approves, and
  // the approval route re-checks both.
  if (approvalAction === "submit") {
    let requested: Date | null = null;
    if (wantsSchedule) {
      const validation = validateScheduledFor(body.scheduledFor, new Date());
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
      requested = validation.date;
    }

    const scheduledFor = submissionScheduledFor(job, requested);

    // One conditional write pinned to the version just read (status AND
    // updatedAt): a cron claim, a concurrent submit or an edit in between
    // makes this a no-op instead of a double submission.
    const { count } = await prisma.postJob.updateMany({
      where: {
        id: postJobId,
        workspaceId: workspaceContext.workspace.id,
        status: job.status,
        updatedAt: job.updatedAt,
      },
      data: { ...holdForApprovalData(new Date()), scheduledFor },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "This post changed in the meantime. Refresh and try again.", code: "NOT_PUBLISHABLE" },
        { status: 409 },
      );
    }

    await notifyOwnersOfApprovalRequest({
      workspaceId: workspaceContext.workspace.id,
      workspaceName: workspaceContext.workspace.name,
      submitter: workspaceContext.user,
      caption: job.baseCaption ?? "",
    });

    return NextResponse.json(
      {
        ok: true,
        status: "draft",
        approvalState: "pending",
        scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
      },
      { status: 202 },
    );
  }

  // Path 1 — schedule a draft for later (a scheduled job reschedules via PATCH).
  if (wantsSchedule) {
    if (job.status !== "draft") {
      return NextResponse.json(
        { error: "Only a draft can be scheduled here.", code: "NOT_A_DRAFT" },
        { status: 409 },
      );
    }

    const validation = validateScheduledFor(body.scheduledFor, new Date());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { count } = await prisma.postJob.updateMany({
      where: { id: postJobId, workspaceId: workspaceContext.workspace.id, status: "draft" },
      data: { status: "scheduled", scheduledFor: validation.date },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "This draft is no longer available to schedule.", code: "NOT_A_DRAFT" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { ok: true, status: "scheduled", scheduledFor: validation.date.toISOString() },
      { status: 200 },
    );
  }

  // Publish-now (live fan-out): require verified email when Resend is configured.
  if (!isEmailVerifiedForPublish(workspaceContext.user)) {
    return NextResponse.json(
      { error: EMAIL_VERIFY_REQUIRED_MESSAGE, code: "EMAIL_VERIFY_REQUIRED" },
      { status: 403 },
    );
  }

  // Path 2 — publish now. Accept a draft or a scheduled job; a running/terminal
  // one can't be published again.
  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status)) {
    return NextResponse.json(
      { error: "Only a draft or scheduled post can be published.", code: "NOT_PUBLISHABLE" },
      { status: 409 },
    );
  }

  // Require ≥1 connection up front and leave the job intact if there are none
  // (don't consume it on a fixable error). Team Workspaces (Task 4): scoped
  // to the WORKSPACE — connections are shared by every member (schema §2:
  // `SocialConnection.workspaceId`, unique per `[workspaceId, platform]`), so
  // a member who didn't personally connect anything must still see them.
  const connectionCount = await prisma.socialConnection.count({
    where: { workspaceId: workspaceContext.workspace.id },
  });
  if (connectionCount === 0) {
    return NextResponse.json(
      {
        error: "Connect at least one platform before publishing.",
        code: "NO_CONNECTIONS",
      },
      { status: 400 },
    );
  }

  // Atomic claim {draft|scheduled} → in_progress. Only one caller wins — this
  // also blocks the cron from double-claiming a scheduled job we're publishing.
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
    },
    data: { status: "in_progress" },
  });

  if (count === 0) {
    return NextResponse.json(
      { error: "This post is no longer available to publish.", code: "NOT_PUBLISHABLE" },
      { status: 409 },
    );
  }

  // Materialize results from current connections + build the publish payload.
  const prep = await prepareDeferredPostJobDispatch(postJobId);
  if (!prep.ok) {
    // A connection was removed in the tiny window since the count above; the
    // job was marked `failed` inside prepare so it never hangs in_progress.
    return NextResponse.json(
      {
        error: "Couldn't publish — no connected platforms are available.",
        code: prep.reason,
      },
      { status: 409 },
    );
  }

  // The job is already committed `in_progress` with pending results: if the
  // event can't be handed to Inngest, fail those results now (job → failed)
  // so it can't hang "publishing", and tell the caller to try again.
  try {
    await inngest.send({ name: "post/publish.requested", data: prep.event });
  } catch (error) {
    logger.error("[POST /api/posts/[postJobId]/publish] Couldn't dispatch the publish event", {
      error,
      postJobId,
    });
    await failPendingPostJobResults(postJobId, DISPATCH_FAILURE);
    return NextResponse.json(
      { code: DISPATCH_FAILURE.errorCode, error: DISPATCH_FAILURE.errorMessage },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, status: "in_progress" }, { status: 202 });
}
