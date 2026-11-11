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
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { SCHEDULE_BUFFER_MS } from "@/lib/scheduling";
import { getWorkspaceContext } from "@/lib/workspace";
import { DISPATCH_FAILURE, failPendingPostJobResults } from "@/server/jobs/failPendingResults";
import { buildPublishEvent, prepareDeferredPostJobDispatch } from "@/server/jobs/posting";
import { sendEmail } from "@/server/notifications/email";
import { buildApprovalDecisionEmail } from "@/server/notifications/approvalEmail";
import { checkDailyPostLimit } from "@/server/usage/workspaceUsage";

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
 *  - 200 body: `{ ok, decision, status, approvalState, scheduledFor }`, where
 *    `scheduledFor` is the time the post is now scheduled for (only when
 *    `status` is `scheduled`, else null).
 *  - An `inngest.send` failure on approve-and-publish fails the job's pending
 *    results (`DISPATCH_FAILED`) and 503s instead of leaving it in_progress.
 */
export async function POST(request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: {
      status: true,
      scheduledFor: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      userId: true,
      baseCaption: true,
      updatedAt: true,
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

  // Usage limits (2026-11-10): approving commits the post to a UTC day, its kept
  // slot or today. At the limit nothing is decided, so the owner can retry later.
  if (outcome !== null) {
    const refusal = await checkDailyPostLimit({
      workspaceId: workspaceContext.workspace.id,
      day: outcome === "schedule" && job.scheduledFor ? job.scheduledFor : now,
      mode: outcome === "schedule" ? "schedule" : "now",
      excludePostJobId: postJobId,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 429 });
    }
  }

  // Atomic claim: only a still-undecided submission (draft, or a scheduled row
  // left submitted-but-unapproved — ruling R10 backstop) at the version just
  // read transitions, so a concurrent decision, publish or cancel can't
  // double-dispatch and a concurrent edit can't be decided unseen.
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...APPROVAL_DECIDABLE_STATUSES] },
      submittedForApprovalAt: { not: null },
      approvedAt: null,
      updatedAt: job.updatedAt,
    },
    data: approving
      ? {
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
        }
      : { status: nextStatus },
  });

  if (count === 0) {
    // Lost the write: if the post is still undecided, it was edited mid-request.
    const current = await prisma.postJob.findFirst({
      where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
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

  // Publish-now path: materialize results from current connections and fire the
  // one publish event, exactly like the publish route.
  if (outcome === "publish_now") {
    const prep = await prepareDeferredPostJobDispatch(postJobId);
    if (!prep.ok) {
      // No usable connections — `prepare` already marked the job failed so it
      // never hangs in_progress. The approval itself stands (recorded above).
      return NextResponse.json(
        {
          error: "Approved, but couldn't publish — no connected platforms are available.",
          code: prep.reason,
        },
        { status: 409 },
      );
    }
    // Same contract as the publish route: if the event can't be handed to
    // Inngest, fail the pending results (job → failed) rather than leave it
    // "publishing" forever. The approval itself stands.
    try {
      // Stable event id + "Post now" priority (2026-11-01 scale audit, jobs H6 + H1).
      await inngest.send(buildPublishEvent(prep.event, { immediate: true }));
    } catch (error) {
      logger.error("[POST /api/posts/[postJobId]/approval] Couldn't dispatch the publish event", {
        error,
        postJobId,
      });
      await failPendingPostJobResults(postJobId, DISPATCH_FAILURE);
      return NextResponse.json(
        { code: DISPATCH_FAILURE.errorCode, error: DISPATCH_FAILURE.errorMessage },
        { status: 503 },
      );
    }
  }

  // The time the post is now scheduled for — only when approval kept its slot.
  const scheduledForIso =
    nextStatus === "scheduled" && job.scheduledFor ? job.scheduledFor.toISOString() : null;

  // Tell the member. Fire-and-forget: sendEmail never throws, and the extra
  // try/catch documents that a mail failure must not fail the decision.
  try {
    const submitter = await prisma.user.findUnique({
      where: { id: job.userId },
      select: { email: true },
    });
    if (submitter?.email) {
      const email = buildApprovalDecisionEmail({
        approved: approving,
        workspaceName: workspaceContext.workspace.name,
        caption: job.baseCaption ?? "",
        scheduledFor: scheduledForIso,
        appBaseUrl: process.env.NEXTAUTH_URL || null,
      });
      await sendEmail({ to: submitter.email, ...email });
    }
  } catch {
    // Ignored on purpose — the decision is already committed.
  }

  return NextResponse.json(
    { ok: true, decision, status: nextStatus, approvalState, scheduledFor: scheduledForIso },
    { status: 200 },
  );
}
