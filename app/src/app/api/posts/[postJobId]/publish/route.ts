import { sendAgainTooOld, TOO_OLD_TO_SEND_ERROR } from "@/lib/sendAgain";
import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { prisma } from "@/lib/db";
import {
  holdForApprovalData,
  needsApproval,
  publishApprovalAction,
  releaseApprovalHoldData,
  submissionScheduledFor,
} from "@/lib/approval";
import { readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { DISPATCH_FAILURE } from "@/server/jobs/failPendingResults";
import { resolvePlatformCaptions } from "@/server/jobs/posting";
import { isPostMediaComplete } from "@/server/jobs/postMedia";
import { notifyOwnersOfApprovalRequest } from "@/server/notifications/approvalRequested";
import { storyPlatformsOf, withStoryCaptions } from "@/lib/storyPlacement";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";
import { MUTABLE_POST_JOB_STATUSES, validateScheduledFor } from "@/lib/scheduling";

import {
  applyToPair,
  dispatchNow,
  notSentNote,
  pairLimitArgs,
  pairStoryPlatforms,
  readPairHalf,
  wantsPair,
  type PairHalf,
} from "../pairRule";

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
 *
 * F1 H3: publish-now also takes a `failed` post with NO results: a scheduled
 * post our side could not send (the reconciler gave up on it), which Retry
 * cannot reach. Activity's Send again button calls this route for it. A member
 * under approval may send one only if an owner approved it.
 *
 * R3-client-journey M1: with `includePair: true` (a Feed and Story card) every
 * path takes the other half too, with the same checks, in one transaction
 * (pairRule.ts): Publish now claims both and sends both events, Submit holds
 * both and the owners' one email says the post also goes out as a Story, and
 * scheduling a draft schedules both at the same time.
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
  const parsedBody = await readJsonObject(request);
  const body = (parsedBody ?? {}) as PublishBody;

  const wantsSchedule = body.scheduledFor != null;

  // Ownership + current status in one read; 404 if not in the caller's
  // workspace. Team Workspaces (Task 4): any member may publish (design §1).
  const workspaceId = workspaceContext.workspace.id;
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: {
      status: true,
      scheduledFor: true,
      createdAt: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      baseCaption: true,
      // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads, so the
      // submission email shows the owners the per-platform texts too.
      perPlatformOverrides: true,
      publishMetadata: true,
      mediaItem: { select: { baseCaption: true, perPlatformOverrides: true, deletedAt: true } },
      updatedAt: true,
      // F1 H3: a failed post with no results was never sent; Post now may send it.
      _count: { select: { results: true } },
      // Review round 2, item 1: a post whose media is gone is refused like Retry refuses it.
      mediaItemId: true,
      media: {
        orderBy: { position: "asc" },
        select: { position: true, mediaItem: { select: { id: true, deletedAt: true } } },
      },
      // R3-client-journey M1: where a Feed and Story card finds its other half.
      storyOfPostJobId: true,
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const approvalActionOf = (row: Parameters<typeof publishApprovalAction>[0]["job"]) =>
    publishApprovalAction({
      requireApproval: workspaceContext.workspace.requireApproval,
      role: workspaceContext.role,
      job: row,
    });
  const approvalAction = approvalActionOf(job);

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

  // R3-client-journey M1: a Feed and Story card asks for both halves. The other
  // half takes the same path as this post only when the same approval rule
  // gives it the same answer; otherwise it is left alone and the answer says why.
  const half = await readPairHalf(
    workspaceId,
    { id: postJobId, storyOfPostJobId: job.storyOfPostJobId ?? null },
    wantsPair(parsedBody),
  );
  const main = { ...job, id: postJobId };
  const approvalBlocker = (other: PairHalf): string | null => {
    const action = approvalActionOf(other);
    if (action === approvalAction) return null;
    if (action === "awaiting_approval" || action === "approve_instead") return "is already waiting for approval";
    return action === "submit" ? "is not approved yet" : "is already approved";
  };

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

    // One time for the post; a pair's Story keeps the same one.
    const scheduledFor = submissionScheduledFor(job, requested);

    // One conditional write pinned to the version just read (status AND
    // updatedAt): a cron claim, a concurrent submit or an edit in between
    // makes this a no-op instead of a double submission.
    const result = await applyToPair({
      main,
      half,
      write: async (db, row) =>
        (
          await db.postJob.updateMany({
            where: { id: row.id, workspaceId, status: row.status, updatedAt: row.updatedAt },
            data: { ...holdForApprovalData(new Date()), scheduledFor },
          })
        ).count === 1,
      blocker: approvalBlocker,
      wording: { done: "was sent for approval too", verb: "sent for approval" },
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: "This post changed in the meantime. Refresh and try again.", code: "NOT_PUBLISHABLE" },
        { status: 409 },
      );
    }

    await notifyOwnersOfApprovalRequest({
      workspaceId,
      workspaceName: workspaceContext.workspace.name,
      submitter: workspaceContext.user,
      caption: job.baseCaption ?? "",
      // A Story publishes no caption: its platform reads "Story, no caption" (2026-11-10).
      platformCaptions: withStoryCaptions(
        resolvePlatformCaptions(job, job.mediaItem),
        storyPlatformsOf(job.publishMetadata),
      ),
      // One email for the pair: it says the post also goes out as a Story.
      ...(half && result.pair?.changed ? { alsoAsStory: pairStoryPlatforms(job.publishMetadata, half) } : {}),
    });

    return NextResponse.json(
      {
        ok: true,
        status: "draft",
        approvalState: "pending",
        scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
        ...(result.pair ? { pair: result.pair } : {}),
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

    const blocker = (other: PairHalf) =>
      other.status !== "draft" ? "is already scheduled" : approvalBlocker(other);

    // Usage limits (2026-11-10): the draft is committed to this UTC day.
    const refusal = await checkDailyPostLimit({
      workspaceId,
      day: validation.date,
      mode: "schedule",
      ...pairLimitArgs(postJobId, half && !blocker(half) ? half : null),
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }

    // Pinned to the version read (status AND updatedAt): what this writes
    // depends on that version's approval columns, so a member submitting the
    // draft in between must make it miss (409) — not leave it scheduled
    // + submitted + unapproved, which the cron never claims.
    const result = await applyToPair({
      main,
      half,
      write: async (db, row) =>
        (
          await db.postJob.updateMany({
            where: { id: row.id, workspaceId, status: "draft", updatedAt: row.updatedAt },
            // Client review link: every write that schedules a post clears the
            // client's marks, so the client looks it over as a new post. A post
            // still pending approval that is allowed through here (approval was
            // turned off since it was submitted) stops being "awaiting approval"
            // in the same write (ruling R10).
            data: {
              status: "scheduled",
              scheduledFor: validation.date,
              clientApprovedAt: null,
              clientChangeRequestedAt: null,
              clientNote: null,
              ...releaseApprovalHoldData(row),
            },
          })
        ).count === 1,
      blocker,
      wording: { done: "was scheduled too", verb: "scheduled" },
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: "This draft is no longer available to schedule.", code: "NOT_A_DRAFT" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        status: "scheduled",
        scheduledFor: validation.date.toISOString(),
        ...(result.pair ? { pair: result.pair } : {}),
      },
      { status: 200 },
    );
  }

  // Path 2 — publish now. Accept a draft or a scheduled job, or a failed one no
  // platform was ever tried for (F1 H3); a running or finished one can't be
  // published again (a failed one with results is retried instead).
  const unsent = job.status === "failed" && job._count?.results === 0;
  if (!MUTABLE_POST_JOB_STATUSES.includes(job.status) && !unsent) {
    return NextResponse.json(
      { error: "Only a draft or scheduled post can be published.", code: "NOT_PUBLISHABLE" },
      { status: 409 },
    );
  }
  // A post from weeks ago would publish stale content today (lib/sendAgain.ts).
  if (unsent && sendAgainTooOld(job, Date.now())) {
    return NextResponse.json({ error: TOO_OLD_TO_SEND_ERROR, code: "TOO_OLD" }, { status: 409 });
  }
  if (
    unsent &&
    needsApproval({
      requireApproval: workspaceContext.workspace.requireApproval,
      role: workspaceContext.role,
      approvedAt: job.approvedAt,
    })
  ) {
    return NextResponse.json(
      { code: "AWAITING_APPROVAL", error: "An owner needs to approve this post first. Ask an owner to use Send again." },
      { status: 409 },
    );
  }

  // Review round 2, item 1: the file must still exist (the retention sweep may
  // have removed it from an old failed post). Same check and answer as Retry,
  // before anything is claimed. A post with several photos needs every photo; a
  // post without a file has none to lose.
  const photos = job.media ?? [];
  const photoGone =
    photos.length > 0 &&
    (!isPostMediaComplete(job.mediaItemId ?? null, photos) || photos.some((row) => row.mediaItem.deletedAt !== null));
  const mediaGone = job.mediaItem != null && job.mediaItem.deletedAt != null;
  if (mediaGone || photoGone) {
    return NextResponse.json(
      { error: "This post's media is no longer available — recreate the post.", code: "MEDIA_UNAVAILABLE" },
      { status: 409 },
    );
  }
  const blocker = (other: PairHalf) =>
    other.mediaItem?.deletedAt != null ? "has lost its media" : approvalBlocker(other);

  // Require ≥1 connection up front and leave the job intact if there are none
  // (don't consume it on a fixable error). Team Workspaces (Task 4): scoped
  // to the WORKSPACE — connections are shared by every member (schema §2:
  // `SocialConnection.workspaceId`, unique per `[workspaceId, platform]`), so
  // a member who didn't personally connect anything must still see them.
  const connectionCount = await prisma.socialConnection.count({
    where: { workspaceId },
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
    workspaceId,
    day: publishedAt,
    mode: "now",
    ...pairLimitArgs(postJobId, half && !blocker(half) ? half : null),
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
  // An unsent failed post is claimed only while it still has no results (the
  // other half of a pair is never a failed one: that one is left alone).
  const result = await applyToPair({
    main,
    half,
    write: async (db, row) => {
      const rowUnsent = row.status === "failed";
      const { count } = await db.postJob.updateMany({
        where: rowUnsent
          ? { id: row.id, workspaceId, status: "failed", results: { none: {} }, updatedAt: row.updatedAt }
          : { id: row.id, workspaceId, status: { in: [...MUTABLE_POST_JOB_STATUSES] }, updatedAt: row.updatedAt },
        // A post still pending approval that is allowed through here (approval
        // was turned off since it was submitted) stops being "awaiting approval"
        // in the same write as its claim (ruling R10). Send again sets
        // retriedAt like Retry, so Activity keeps the post on "Had a problem"
        // (review round 2, item 5).
        data: {
          status: "in_progress",
          scheduledFor: publishedAt,
          ...releaseApprovalHoldData(row),
          ...(rowUnsent ? { retriedAt: publishedAt } : {}),
        },
      });
      return count === 1;
    },
    blocker,
    wording: { done: "is publishing too", verb: "published" },
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "This post is no longer available to publish.", code: "NOT_PUBLISHABLE" },
      { status: 409 },
    );
  }

  // Materialize results from current connections + hand the publish events
  // (one per claimed half) to Inngest in one send.
  let pair = result.pair;
  const dispatch = await dispatchNow([postJobId, ...(half && pair?.changed ? [half.id] : [])], {
    route: "POST /api/posts/[postJobId]/publish",
  });
  if (pair && dispatch.notSent.has(pair.id)) pair = { ...pair, note: notSentNote(pair.kind) };
  const pairAnswer = pair ? { pair } : {};

  if (dispatch.notSent.has(postJobId)) {
    // No chosen platform is connected (F1 H1): prepare gave each one a failed
    // result with its own sentence and marked the job `failed`, so it never
    // hangs in_progress and Activity shows what to reconnect.
    return NextResponse.json(
      {
        error: "Nothing was posted: none of this post's platforms is connected. Activity shows what to reconnect.",
        code: dispatch.reasons.get(postJobId),
        ...pairAnswer,
      },
      { status: 409 },
    );
  }

  // The job is already committed `in_progress` with pending results: if the
  // event can't be handed to Inngest, those results were failed (job → failed)
  // so it can't hang "publishing"; tell the caller to try again.
  if (dispatch.sendFailed) {
    return NextResponse.json(
      { code: DISPATCH_FAILURE.errorCode, error: DISPATCH_FAILURE.errorMessage },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, status: "in_progress", ...pairAnswer }, { status: 202 });
}
