import { NextResponse, type NextRequest } from "next/server";

import {
  APPROVAL_DECIDABLE_STATUSES,
  canDecideApproval,
  changedSinceReview,
  decideApproval,
  deriveApprovalState,
  isAwaitingApprovalDecision,
} from "@/lib/approval";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { SCHEDULE_BUFFER_MS } from "@/lib/scheduling";
import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { DISPATCH_FAILURE, finishPostJob } from "@/server/jobs/failPendingResults";
import { sendEmail } from "@/server/notifications/email";
import { buildApprovalDecisionEmail } from "@/server/notifications/approvalEmail";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";

import {
  applyToPair,
  dispatchNow,
  failedStartAnswer,
  isLiveHalf,
  notSentNote,
  pairLimitArgs,
  partialSendMessage,
  pairStoryPlatforms,
  readPairHalf,
  releaseReservation,
  reserveSendNow,
  takenFeedHalf,
  wantsPair,
  type PairHalf,
  type SendNowReservation,
} from "../pairRule";
import { signedOutResponse } from "@/lib/signedOutResponse";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

interface ApprovalBody {
  decision?: unknown;
  /** ISO `updatedAt` of the version the owner reviewed (optional). */
  reviewedUpdatedAt?: unknown;
}

const CHANGED_SINCE_REVIEW_BODY = {
  code: "CHANGED_SINCE_REVIEW",
  error: "This post changed since you opened it. Review the latest version.",
} as const;

/** See the sibling routes — generous throttle shared by the DB-only mutations. */
/**
 * R9-client-journey L3: why nothing went out, in the submitter's decision
 * email. The submitter is a member: only an owner can reconnect.
 */
const NOT_SENT_NOTHING_CONNECTED =
  "none of this post's platforms is connected. The workspace owner can reconnect them in Settings; Activity shows which.";
const NOT_SENT_SEND_FAILED = "publishing couldn't start. Open the post in Activity and retry it there.";
/** R28 publishing L2: the failed start left the post with no results, so Activity offers Send again on it. */
const NOT_SENT_SEND_FAILED_NO_RESULTS =
  "publishing couldn't start. Open the post in Activity and press Send again on it.";

/** What happened to the submitter's decision email (R23-client-journey L4). */
type AuthorEmail = "sent" | "removed" | "failed";

const MUTATE_RATE_LIMIT = {
  route: "posts/mutate",
  limit: 60,
  windowMs: 5 * 60 * 1000,
} as const;

/**
 * POST /api/posts/[postJobId]/approval — decide a member's held post.
 *
 * Body `{ decision: "approve" | "reject" }`. OWNER-ONLY (members submit, owners
 * decide) and only for a genuinely pending submission — `canDecideApproval`
 * refuses anything already decided or never submitted, so a double-click can't
 * approve twice.
 *
 * Approving honors the member's chosen time when it is still far enough out
 * (`approvalOutcome` → `scheduled`, picked up by the cron due-scanner) and
 * otherwise publishes immediately through the SAME path the publish route uses
 * (`prepareDeferredPostJobDispatch` materializes per-platform results from the
 * connections that exist NOW, then one `post/publish.requested` event) — so a
 * slot that passed during review still goes out instead of silently never
 * publishing. Rejecting cancels the post and leaves `approvedAt` null, which is
 * what `deriveApprovalState` reads back as "rejected".
 *
 * Every transition is an ATOMIC conditional `updateMany` on a still-undecided
 * submission (`isAwaitingApprovalDecision`: a held draft, or — the ruling R10
 * backstop — a `scheduled` row the pre-fix publish route left submitted but
 * unapproved, which the cron never claims), so a concurrent
 * decide/publish/cancel can't double-dispatch. The member's decision email is
 * fire-and-forget: it must never fail the decision.
 *
 * 2026-11-01 audit:
 *  - Optional body `reviewedUpdatedAt` (the `updatedAt` the owner reviewed):
 *    a mismatch 409s `CHANGED_SINCE_REVIEW` without deciding, and the decision
 *    write is also pinned to the `updatedAt` just read, so a member's edit
 *    landing mid-request can't be approved unseen.
 *  - 200 body: `{ ok, decision, status, approvalState, scheduledFor, authorEmail }`,
 *    where `scheduledFor` is the time the post is now scheduled for (only when
 *    `status` is `scheduled`, else null) and `authorEmail` is "sent" (Resend
 *    accepted it), "removed" (the submitter left; no email) or "failed".
 *  - An `inngest.send` failure on approve-and-publish fails the job's pending
 *    results (`DISPATCH_FAILED`) and 503s instead of leaving it in_progress.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return signedOutResponse();
  }

  // Pause (2026-11-10): a paused workspace cannot create or move work.
  const blocked = accessBlockResponse(workspaceContext);
  if (blocked) return blocked;

  const rateLimit = await checkRateLimit({
    userId: workspaceContext.user.id,
    ...MUTATE_RATE_LIMIT,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  // Next 16 passes params as a promise — it MUST be awaited (see the post-job
  // route's params bug: an undefined id makes Prisma match the first row).
  const { postJobId } = await Promise.resolve(context.params);

  const parsedBody = await readJsonObject(request);
  if (!parsedBody) {
    return invalidJsonBodyResponse();
  }
  const body = parsedBody as ApprovalBody;

  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json(
      { error: 'decision must be "approve" or "reject".' },
      { status: 400 },
    );
  }
  const decision = body.decision;
  const approving = decision === "approve";

  const reviewedUpdatedAt = body.reviewedUpdatedAt ?? null;
  if (reviewedUpdatedAt !== null && typeof reviewedUpdatedAt !== "string") {
    return NextResponse.json(
      { error: "reviewedUpdatedAt must be an ISO-8601 timestamp." },
      { status: 400 },
    );
  }

  const workspaceId = workspaceContext.workspace.id;
  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId },
    select: {
      status: true,
      scheduledFor: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      userId: true,
      baseCaption: true,
      updatedAt: true,
      storyOfPostJobId: true,
      // R3-client-journey M1: the member's email names the Story of a pair.
      publishMetadata: true,
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const state = deriveApprovalState(job);

  // Members never decide — and this must be checked before the state gate so a
  // member probing a decided job can't distinguish 403 from 409.
  if (workspaceContext.role !== "owner") {
    return NextResponse.json(
      { error: "Only the workspace owner can do that." },
      { status: 403 },
    );
  }

  // A submission that is already running or finished reads "pending" too, but
  // there is nothing left to decide — only a draft or scheduled row is.
  if (!canDecideApproval({ role: workspaceContext.role, state }) || !isAwaitingApprovalDecision(job)) {
    return NextResponse.json(
      {
        error: "This post isn't awaiting approval.",
        code: "NOT_PENDING_APPROVAL",
      },
      { status: 409 },
    );
  }

  // The owner reviewed an older version — make them look at the current one.
  if (changedSinceReview(reviewedUpdatedAt, job.updatedAt)) {
    return NextResponse.json(CHANGED_SINCE_REVIEW_BODY, { status: 409 });
  }

  const now = new Date();
  const { status: nextStatus, approvalState, outcome } = decideApproval({
    decision,
    scheduledFor: job.scheduledFor,
    now,
    bufferMs: SCHEDULE_BUFFER_MS,
  });

  // R3-client-journey M1: a held Feed and Story card is one submission, so the
  // decision takes both halves; only a half still awaiting a decision. A reject
  // takes it even without includePair, as R2 did, so a tab still running the
  // old Queue never rejects one half alone.
  const askedForPair = wantsPair(parsedBody);
  const half = await readPairHalf(
    workspaceId,
    { id: postJobId, storyOfPostJobId: job.storyOfPostJobId ?? null },
    askedForPair || !approving,
  );
  const blocker = (other: PairHalf) => (isAwaitingApprovalDecision(other) ? null : "is not waiting for approval");

  // Usage limits (2026-11-10): approving commits the post to a UTC day, its kept
  // slot or today. At the limit nothing is decided, so the owner can retry later.
  if (outcome !== null) {
    const refusal = await checkDailyPostLimit({
      workspaceId,
      day: outcome === "schedule" && job.scheduledFor ? job.scheduledFor : now,
      mode: outcome === "schedule" ? "schedule" : "now",
      ...pairLimitArgs(postJobId, half && !blocker(half) ? half : null),
      viewerUserId: workspaceContext.user.id,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }
  }

  // Second look at T1, item 1: approving to publish now reserves the runs
  // (this post and the other half it takes, as one unit) before the decision
  // is written, so at a limit the post stays pending: the approver reads the
  // sentence and the submitter is told nothing, because nothing changed.
  let reservation: Extract<SendNowReservation, { ok: true }> | null = null;
  if (approving && outcome === "publish_now") {
    const takenHalf = half && isLiveHalf(half) && !blocker(half) ? half : null;
    const reserved = await reserveSendNow({
      workspaceId,
      postJobIds: [postJobId, ...(takenHalf ? [takenHalf.id] : [])],
      viewerUserId: workspaceContext.user.id,
    });
    if (!reserved.ok) return NextResponse.json(reserved.body, { status: reserved.status });
    reservation = reserved;
  }

  // Atomic claim: only a still-undecided submission (draft, or a scheduled row
  // left submitted-but-unapproved — ruling R10 backstop) at the version just
  // read transitions, so a concurrent decision, publish or cancel can't
  // double-dispatch and a concurrent edit can't be decided unseen. The other
  // half of a pair is pinned to the version of it read just now.
  const claimWhere = (row: { id: string; updatedAt: Date }) => ({
    id: row.id,
    workspaceId,
    status: { in: [...APPROVAL_DECIDABLE_STATUSES] },
    submittedForApprovalAt: { not: null },
    approvedAt: null,
    updatedAt: row.updatedAt,
  });
  const approveData = {
    status: nextStatus,
    approvedAt: now,
    approvedByUserId: workspaceContext.user.id,
    // Usage limits (2026-11-10): a post published now counts toward today,
    // the day the limit was checked for above, not its creation day or a
    // slot that passed during review.
    ...(outcome === "publish_now" ? { scheduledFor: now } : {}),
    // Client review link: every write that schedules a post clears the
    // client's marks, so the client looks it over as a new post.
    ...(nextStatus === "scheduled"
      ? { clientApprovedAt: null, clientChangeRequestedAt: null, clientNote: null }
      : {}),
  };
  const result = await applyToPair({
    main: { ...job, id: postJobId },
    half,
    // A reject cancels the post, a final state, so it goes through finishPostJob,
    // which also stamps the post's media as used now (second review, item 1).
    write: async (db, row) =>
      approving
        ? (await db.postJob.updateMany({ where: claimWhere(row), data: approveData })).count === 1
        : (await finishPostJob(db, { where: claimWhere(row), data: { status: nextStatus } })) === 1,
    blocker,
    wording: approving
      ? { done: "was approved too", verb: "approved" }
      : { done: "was rejected too", verb: "rejected" },
  });

  if (!result.ok) {
    // Nothing was decided: the reservation goes.
    if (reservation) await releaseReservation(reservation.reserved);
    // Lost the write: if the post is still undecided, it was edited mid-request.
    const current = await prisma.postJob.findFirst({
      where: { id: postJobId, workspaceId },
      select: { status: true, submittedForApprovalAt: true, approvedAt: true },
    });
    if (current && isAwaitingApprovalDecision(current)) {
      return NextResponse.json(CHANGED_SINCE_REVIEW_BODY, { status: 409 });
    }
    return NextResponse.json(
      {
        error: "This post is no longer awaiting approval.",
        code: "NOT_PENDING_APPROVAL",
      },
      { status: 409 },
    );
  }
  // R4 lows, item 4: an old tab's reject asked about no other half, so the
  // answer names one only when it was rejected too.
  let pair = askedForPair || result.pair?.changed ? result.pair : null;
  const pairDecided = Boolean(half && pair?.changed);
  // One half went out and the other had nothing to send: a success that says both.
  let partial: string | null = null;

  // The time the post is now scheduled for — only when approval kept its slot.
  const scheduledForIso =
    nextStatus === "scheduled" && job.scheduledFor ? job.scheduledFor.toISOString() : null;

  // Tell the member, once, naming the Story when the decision took it too.
  // Fire-and-forget: sendEmail never throws, and the extra try/catch documents
  // that a mail failure must not fail the decision. R9-client-journey L3:
  // `notSent` when it was approved to publish now and then nothing went out.
  // R23-client-journey L4: it says what happened to the email, so the Queue
  // claims "the author has been notified" only when Resend accepted it. The
  // send is awaited before the answer already, so this costs no extra time.
  const tellSubmitter = async (
    notSent?: string,
    startUnconfirmed = false,
    withoutResults = false,
    otherHalf?: { note?: string; mayHaveStarted?: boolean },
  ): Promise<AuthorEmail> => {
    try {
      // R7-client-journey L1: only a submitter who is still a member hears about
      // it, as with the post-finished emails (postOutcomeEmail.ts); one who was
      // removed or left gets no caption, time or link.
      const stillMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: job.userId } },
        select: { id: true },
      });
      const submitter = stillMember
        ? await prisma.user.findUnique({
            where: { id: job.userId },
            // F4: the scheduled time is shown in the member's own zone.
            select: { email: true, timeZone: true },
          })
        : null;
      if (!stillMember) return "removed";
      if (submitter?.email) {
        const email = buildApprovalDecisionEmail({
          approved: approving,
          workspaceId,
          workspaceName: workspaceContext.workspace.name,
          // R4 lows, item 3: decided from a Story, the email shows its feed post.
          caption: (takenFeedHalf(half, pair) ?? job).baseCaption ?? "",
          scheduledFor: scheduledForIso,
          timeZone: submitter.timeZone ?? null,
          appBaseUrl: process.env.NEXTAUTH_URL || null,
          ...(half && pairDecided ? { alsoAsStory: pairStoryPlatforms(job.publishMetadata, half) } : {}),
          ...(notSent ? { notSent } : {}),
          ...(startUnconfirmed ? { startUnconfirmed: true, ...(withoutResults ? { withoutResults: true } : {}) } : {}),
          ...(otherHalf?.note ? { otherHalfNote: otherHalf.note } : {}),
          ...(otherHalf?.mayHaveStarted ? { otherHalfMayHaveStarted: true } : {}),
        });
        const sent = await sendEmail({ to: submitter.email, ...email }, { label: "approval-decision" });
        return sent ? "sent" : "failed";
      }
      return "failed";
    } catch {
      // Ignored on purpose — the decision is already committed.
      return "failed";
    }
  };

  // Publish-now path: materialize results from current connections and fire the
  // publish events (one per half of a pair), exactly like the publish route.
  if (outcome === "publish_now") {
    const claimed = [postJobId, ...(half && pairDecided ? [half.id] : [])];
    // A half the write did not take gives its run back.
    if (reservation && claimed.length < reservation.reserved.postJobIds.length) {
      await releaseReservation(reservation.reserved, claimed);
    }
    const dispatch = await dispatchNow(
      claimed,
      { route: "POST /api/posts/[postJobId]/approval" },
      reservation
        ? {
            reserved: {
              ...reservation.reserved,
              postJobIds: reservation.reserved.postJobIds.filter((id) => claimed.includes(id)),
            },
          }
        : {},
    );

    if (pair && dispatch.notSent.has(pair.id)) pair = { ...pair, note: notSentNote(pair.kind) };
    partial = partialSendMessage(postJobId, half, dispatch);
    // Same contract as the publish route: if the events can't be handed to
    // Inngest, the pending results are failed (job → failed) rather than left
    // "publishing" forever. The approval itself stands. Checked first (R4 lows,
    // item 5): when this post had nothing sendable but its other half was
    // prepared, a failed send is still "try again", not "reconnect".
    if (dispatch.sendFailed) {
      // R26 LL3 follow-up: as the toast, a post that couldn't be marked
      // failed shows as publishing for a while, so no "send it again" yet.
      // R28 publishing L2: a post left without results offers Send again, not Retry.
      // R29 publishing L1 + L2: this post's own state, and the other half's
      // note (by its own state) in the answer and the email.
      const failed = failedStartAnswer(postJobId, pair, dispatch);
      const withoutResults = failed.body.withoutResults === true;
      const otherHalf = { note: failed.halfNote, mayHaveStarted: failed.halfMayHaveStarted };
      await (failed.body.resultsMarked
        ? tellSubmitter(withoutResults ? NOT_SENT_SEND_FAILED_NO_RESULTS : NOT_SENT_SEND_FAILED, false, false, otherHalf)
        : tellSubmitter(undefined, true, withoutResults, otherHalf));
      return NextResponse.json(
        // R26 LL3: as Create's 503, so the Queue can say where to retry it and
        // whether it shows as publishing first.
        {
          code: DISPATCH_FAILURE.errorCode,
          error: DISPATCH_FAILURE.errorMessage,
          postJobId,
          ...failed.body,
        },
        { status: 503 },
      );
    }
    // Review of T1, item 1: a daily limit refused it as it went out (its results say so).
    const limited = dispatch.limitRefusals.get(postJobId);
    if (limited && !partial) {
      return NextResponse.json(
        { error: `Approved, but not sent. ${limited.error}`, code: limited.code, ...(pair ? { otherHalf: pair } : {}) },
        { status: 429 },
      );
    }
    if (dispatch.notSent.has(postJobId) && !partial) {
      // No chosen platform is connected (F1 H1): `prepare` gave each one a
      // failed result with its sentence and marked the job failed, so it never
      // hangs in_progress. The approval itself stands (recorded above).
      await tellSubmitter(NOT_SENT_NOTHING_CONNECTED);
      return NextResponse.json(
        {
          error:
            "Approved, but nothing was posted: none of this post's platforms is connected. Activity shows what to reconnect.",
          code: dispatch.reasons.get(postJobId),
          ...(pair ? { otherHalf: pair } : {}),
        },
        { status: 409 },
      );
    }
  }

  const authorEmail = await tellSubmitter();

  return NextResponse.json(
    {
      ok: true,
      decision,
      status: nextStatus,
      approvalState,
      scheduledFor: scheduledForIso,
      authorEmail,
      ...(partial ? { message: `Approved. ${partial}` } : {}),
      // R2's answer, still read by a tab running the old Queue.
      ...(!approving && pairDecided ? { pairRejected: true } : {}),
      ...(pair ? { otherHalf: pair } : {}),
    },
    { status: 200 },
  );
}
