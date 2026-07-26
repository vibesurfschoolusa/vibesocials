import { NextResponse, type NextRequest } from "next/server";

import {
  approvalOutcome,
  canDecideApproval,
  deriveApprovalState,
} from "@/lib/approval";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { checkRateLimit } from "@/lib/rateLimit";
import { SCHEDULE_BUFFER_MS } from "@/lib/scheduling";
import { getWorkspaceContext } from "@/lib/workspace";
import { prepareDeferredPostJobDispatch } from "@/server/jobs/posting";
import { sendEmail } from "@/server/notifications/email";
import { buildApprovalDecisionEmail } from "@/server/notifications/approvalEmail";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

interface ApprovalBody {
  decision?: unknown;
}

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
 * Every transition is an ATOMIC conditional `updateMany` on `status: "draft"`,
 * so a concurrent decide/publish/cancel can't double-dispatch. The member's
 * decision email is fire-and-forget: it must never fail the decision.
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

  let body: ApprovalBody = {};
  try {
    body = ((await request.json()) as ApprovalBody) ?? {};
  } catch {
    body = {};
  }

  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json(
      { error: 'decision must be "approve" or "reject".' },
      { status: 400 },
    );
  }
  const approving = body.decision === "approve";

  const job = await prisma.postJob.findFirst({
    where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
    select: {
      status: true,
      scheduledFor: true,
      submittedForApprovalAt: true,
      approvedAt: true,
      userId: true,
      baseCaption: true,
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

  if (!canDecideApproval({ role: workspaceContext.role, state })) {
    return NextResponse.json(
      {
        error: "This post isn't awaiting approval.",
        code: "NOT_PENDING_APPROVAL",
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const outcome = approving
    ? approvalOutcome(job, now, SCHEDULE_BUFFER_MS)
    : null;
  const nextStatus = !approving
    ? "cancelled"
    : outcome === "schedule"
      ? "scheduled"
      : "in_progress";

  // Atomic claim: only a still-`draft` row transitions, so a concurrent
  // decision, publish or cancel can't double-dispatch.
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: "draft",
    },
    data: approving
      ? {
          status: nextStatus,
          approvedAt: now,
          approvedByUserId: workspaceContext.user.id,
        }
      : { status: nextStatus },
  });

  if (count === 0) {
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
  if (approving && outcome === "publish_now") {
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
    await inngest.send({ name: "post/publish.requested", data: prep.event });
  }

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
        scheduledFor:
          approving && outcome === "schedule" && job.scheduledFor
            ? new Date(job.scheduledFor).toISOString()
            : null,
        appBaseUrl: process.env.NEXTAUTH_URL || null,
      });
      await sendEmail({ to: submitter.email, ...email });
    }
  } catch {
    // Ignored on purpose — the decision is already committed.
  }

  return NextResponse.json({ ok: true, status: nextStatus }, { status: 200 });
}
