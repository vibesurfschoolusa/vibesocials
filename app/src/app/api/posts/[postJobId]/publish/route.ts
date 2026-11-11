import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { prisma } from "@/lib/db";
import {
  holdForApprovalData,
  publishApprovalAction,
  releaseApprovalHoldData,
  submissionScheduledFor,
} from "@/lib/approval";
import { readJsonObject } from "@/lib/http";
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import {
  buildPublishEvent,
  prepareDeferredPostJobDispatch,
  resolvePlatformCaptions,
} from "@/server/jobs/posting";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { storyPlatformsOf, withStoryCaptions } from "@/lib/storyPlacement";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";
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
 * "pending" }`, owners emailed, nothing dispatched).
 *
 * Held posts (ruling R10, final review M1): an OWNER can't publish or schedule
 * a held post while approval is on — 409 `AWAITING_APPROVAL`, approve or reject
 * it instead. With approval off, anyone may, and the claim clears the
 * submission in the same write (`releaseApprovalHoldData`) — leaving it set
 * made a scheduled + submitted + unapproved row the cron never claims and the
 * approval route couldn't decide. Both claims are pinned to the version read
 * (`updatedAt`), since what they write depends on its approval columns.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pause (2026-11-10): a paused workspace cannot create or move work.
  const blocked = accessBlockResponse(workspaceContext);
  if (blocked) return blocked;

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

  // A body is optional (publish-now sends none): an empty, invalid or
  // non-object one (null / array / primitive) is treated as "no body".
  const body = ((await readJsonObject(request)) ?? {}) as PublishBody;

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
      // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads, so the
      // submission email shows the owners the per-platform texts too.
      perPlatformOverrides: true,
      publishMetadata: true,
      mediaItem: { select: { baseCaption: true, perPlatformOverrides: true } },
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

  if (approvalAction === "approve_instead") {
    return NextResponse.json(
      {
        code: "AWAITING_APPROVAL",
        error: "This post is waiting for approval — approve or reject it instead.",
      },
      { status: 409 },
    );
  }

  // Submit for approval instead of publishing/scheduling. Needs no connection
  // yet: nothing goes out until an owner approves, and the approval route
  // re-checks it.
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
      // A Story publishes no caption: its platform reads "Story, no caption" (2026-11-10).
      platformCaptions: withStoryCaptions(
        resolvePlatformCaptions(job, job.mediaItem),
        storyPlatformsOf(job.publishMetadata),
      ),
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

  // A post still pending approval that is allowed through here (approval was
  // turned off since it was submitted) stops being "awaiting approval" in the
  // same write as its claim (ruling R10); {} for everything else.
  const releaseHold = releaseApprovalHoldData(job);

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

    // Usage limits (2026-11-10): the draft is committed to this UTC day.
    const refusal = await checkDailyPostLimit({
      workspaceId: workspaceContext.workspace.id,
      day: validation.date,
      mode: "schedule",
      excludePostJobId: postJobId,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }

    // Pinned to the version read (status AND updatedAt): what this writes
    // depends on that version's approval columns, so a member submitting the
    // draft in between must make it miss (409) — not leave it scheduled
    // + submitted + unapproved, which the cron never claims.
    const { count } = await prisma.postJob.updateMany({
      where: {
        id: postJobId,
        workspaceId: workspaceContext.workspace.id,
        status: "draft",
        updatedAt: job.updatedAt,
      },
      // Client review link: every write that schedules a post clears the
      // client's marks, so the client looks it over as a new post.
      data: {
        status: "scheduled",
        scheduledFor: validation.date,
        clientApprovedAt: null,
        clientChangeRequestedAt: null,
        clientNote: null,
        ...releaseHold,
      },
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

  // Usage limits (2026-11-10): the post goes out today. A scheduled post must
  // not count against itself if it was already on today. The claim below stamps
  // `scheduledFor` with this instant, so the post counts toward today (an old
  // draft would otherwise count toward the day it was created, and a post
  // scheduled for later toward that later day), like a post the scanner found due.
  const publishedAt = new Date();
  const refusal = await checkDailyPostLimit({
    workspaceId: workspaceContext.workspace.id,
    day: publishedAt,
    mode: "now",
    excludePostJobId: postJobId,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
  }

  // Atomic claim {draft|scheduled} → in_progress. Only one caller wins — this
  // also blocks the cron from double-claiming a scheduled job we're publishing.
  // Pinned to the exact version read (updatedAt): the approval decision above
  // was made from it. A member under approval got here only because the post
  // they READ was approved, so an edit that re-held it — or changed its text —
  // in the meantime makes the claim match nothing (409 below) instead of
  // publishing unreviewed content; likewise a submission landing in between
  // can't be published past, or left set on a released hold (ruling R10).
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
      updatedAt: job.updatedAt,
    },
    data: { status: "in_progress", scheduledFor: publishedAt, ...releaseHold },
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
    // Stable event id + "Post now" priority (2026-11-01 scale audit, jobs H6 + H1).
    await inngest.send(buildPublishEvent(prep.event, { immediate: true }));
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
