import type { PostJobStatus } from "@prisma/client";

import type { PostJobIntent } from "./scheduling";

/**
 * Approval workflow (2026-07-26 plan). A held post is an ordinary `draft`
 * carrying `submittedForApprovalAt` — deliberately NOT a new PostJobStatus,
 * which would break every exhaustive Record<PostJobStatus, …> and status set
 * in the codebase (see the schema comment on the PostJobStatus enum).
 */

/**
 * Should this newly created post be held for owner approval instead of
 * publishing/scheduling? Only a MEMBER's post that would actually go out is
 * held: an owner IS the approver, and a draft publishes nothing on its own.
 */
export function shouldHoldForApproval(input: {
  role: "owner" | "member";
  requireApproval: boolean;
  intent: PostJobIntent;
}): boolean {
  if (!input.requireApproval) return false;
  if (input.role === "owner") return false;
  return input.intent !== "draft";
}

export type ApprovalState = "none" | "pending" | "approved" | "rejected";

/** Approval state derived from the job's own columns (no extra enum). */
export function deriveApprovalState(job: {
  submittedForApprovalAt: Date | string | null;
  approvedAt: Date | string | null;
  status: PostJobStatus;
}): ApprovalState {
  if (!job.submittedForApprovalAt) return "none";
  if (job.approvedAt) return "approved";
  // Submitted, never approved, and cancelled => the owner rejected it.
  if (job.status === "cancelled") return "rejected";
  return "pending";
}

/** Only an owner may decide, and only an undecided submission. */
export function canDecideApproval(input: {
  role: "owner" | "member";
  state: ApprovalState;
}): boolean {
  return input.role === "owner" && input.state === "pending";
}

/**
 * What approving should do: honor the member's chosen time when it is still
 * far enough out, else publish immediately — a post whose slot passed while
 * awaiting approval must not silently never go out.
 */
export function approvalOutcome(
  job: { scheduledFor: Date | string | null },
  now: Date,
  bufferMs: number,
): "schedule" | "publish_now" {
  if (!job.scheduledFor) return "publish_now";
  const target = new Date(job.scheduledFor).getTime();
  if (Number.isNaN(target)) return "publish_now";
  return target >= now.getTime() + bufferMs ? "schedule" : "publish_now";
}

/*
 * 2026-11-01 audit — server-side enforcement. The create-time hold above was
 * the ONLY gate, so a member could publish a plain draft, publish a pending
 * post, or edit an approved scheduled post and have the cron publish the
 * unreviewed text. Every rule the publish/edit/approval/cancel routes apply is
 * below; the routes only translate the outcome into a write + HTTP response.
 */

type Role = "owner" | "member";

/** The columns every approval rule reads off a PostJob. */
export interface ApprovalFacts {
  status: PostJobStatus;
  submittedForApprovalAt: Date | string | null;
  approvedAt: Date | string | null;
}

/**
 * Is this post HELD — a `draft` submitted for approval and not yet decided?
 * Stricter than `deriveApprovalState(job) === "pending"`, which also matches a
 * submitted-but-unapproved row that is no longer a draft (e.g. a `scheduled`
 * row the pre-fix publish route produced); only a held draft can be decided,
 * and only a held draft blocks publishing as "awaiting approval".
 */
export function isHeldForApproval(job: ApprovalFacts): boolean {
  return job.status === "draft" && deriveApprovalState(job) === "pending";
}

/**
 * Does this caller need an owner's approval before this job may go out?
 * Owners never do (they ARE the approvers), and a post an owner already
 * approved doesn't need it again.
 */
export function needsApproval(input: {
  requireApproval: boolean;
  role: Role;
  approvedAt: Date | string | null;
}): boolean {
  return input.requireApproval && input.role === "member" && input.approvedAt == null;
}

/**
 * What `POST /api/posts/[id]/publish` does for this caller + job:
 *  - `proceed` — the normal publish/schedule path (whose own status guards
 *    still 409 a running or finished job). If the post is still pending (e.g.
 *    held before the owner turned approval off), the claim releases the hold
 *    in the same write — see {@link releaseApprovalHoldData}.
 *  - `awaiting_approval` — a member's post is already held; publishing it is
 *    refused.
 *  - `approve_instead` — ruling R10: an OWNER publishing or scheduling a held
 *    post while approval is on. Refused: it must be decided through the
 *    approval route (Approve / Reject), which records the decision and tells
 *    the member.
 *  - `submit` — a plain draft, or a scheduled post nobody approved, is SUBMITTED
 *    for approval instead of published. A scheduled row is judged by its status
 *    (not by `submittedForApprovalAt`), so even a submitted-but-unapproved
 *    scheduled row left by the pre-fix bypass is pulled back off the cron.
 */
export function publishApprovalAction(input: {
  requireApproval: boolean;
  role: Role;
  job: ApprovalFacts;
}): "proceed" | "awaiting_approval" | "approve_instead" | "submit" {
  const { requireApproval, role, job } = input;
  if (needsApproval({ requireApproval, role, approvedAt: job.approvedAt })) {
    if (isHeldForApproval(job)) return "awaiting_approval";
    if (job.status === "draft" || job.status === "scheduled") return "submit";
    return "proceed";
  }
  if (requireApproval && role === "owner" && isHeldForApproval(job)) return "approve_instead";
  return "proceed";
}

/**
 * The approval columns a publish-route claim (schedule or publish-now) writes
 * alongside its status change (ruling R10). A post that still reads "pending"
 * when the route lets it go out — held before approval was turned off, or a
 * scheduled row the pre-fix route left submitted-but-unapproved — has its
 * submission cleared in the SAME conditional write: otherwise it would become
 * a scheduled + submitted + unapproved row, which the cron never claims (R6).
 * `approvedAt` stays null (nobody approved it). Anything else is untouched — an
 * owner's approval record is history worth keeping.
 */
export function releaseApprovalHoldData(
  job: ApprovalFacts,
): { submittedForApprovalAt?: null; approvedAt?: null } {
  return deriveApprovalState(job) === "pending"
    ? { submittedForApprovalAt: null, approvedAt: null }
    : {};
}

/** The statuses an owner's approval decision can be applied to. */
export const APPROVAL_DECIDABLE_STATUSES = ["draft", "scheduled"] as const satisfies readonly PostJobStatus[];

/**
 * Can an owner decide this post right now? A held draft — or, the ruling R10
 * backstop, a `scheduled` row still carrying an undecided submission (only
 * the pre-fix publish route produced those; the cron never claims them, so
 * without this they could never be published or cancelled from the UI). A
 * submitted row that is already running or finished has nothing to decide.
 */
export function isAwaitingApprovalDecision(job: ApprovalFacts): boolean {
  return (
    (APPROVAL_DECIDABLE_STATUSES as readonly PostJobStatus[]).includes(job.status) &&
    deriveApprovalState(job) === "pending"
  );
}

/**
 * The columns that (re)hold a post for approval: back to a `draft`, freshly
 * submitted, any earlier decision cleared. Callers add `scheduledFor`.
 */
export function holdForApprovalData(now: Date): {
  status: "draft";
  submittedForApprovalAt: Date;
  approvedAt: null;
  approvedByUserId: null;
} {
  return { status: "draft", submittedForApprovalAt: now, approvedAt: null, approvedByUserId: null };
}

/**
 * The time a publish-route submission keeps for the owner to honor: the
 * requested (already validated) time if one was sent, else a scheduled job's
 * existing time, else none (approving then publishes immediately).
 */
export function submissionScheduledFor(
  job: { status: PostJobStatus; scheduledFor: Date | null },
  requested: Date | null,
): Date | null {
  if (requested) return requested;
  if (job.status === "scheduled") return job.scheduledFor;
  return null;
}

/**
 * What an edit (`PATCH /api/posts/[id]`) does to the approval state. Only a
 * MEMBER in an approval workspace is affected:
 *  - `rehold` — a scheduled post (approved or not) goes back for approval, so
 *    the cron can't publish text nobody reviewed.
 *  - `restamp` — a pending post stays pending; its submission time is
 *    refreshed so owners see when it last changed.
 *  - `none` — everything else (owners, plain drafts) edits as before.
 */
export function editApprovalEffect(input: {
  requireApproval: boolean;
  role: Role;
  job: ApprovalFacts;
}): "none" | "rehold" | "restamp" {
  if (!input.requireApproval || input.role !== "member") return "none";
  const { job } = input;
  if (job.status === "scheduled") return "rehold";
  if (isHeldForApproval(job)) return "restamp";
  return "none";
}

/**
 * Has the post changed since the owner opened it? `reviewedUpdatedAt` is the
 * `updatedAt` the owner's view was rendered from; absent means the client
 * didn't send one (nothing to compare). An unparseable value counts as changed
 * — never decide on a version we can't identify.
 */
export function changedSinceReview(
  reviewedUpdatedAt: string | null | undefined,
  currentUpdatedAt: Date | string,
): boolean {
  if (reviewedUpdatedAt == null) return false;
  const reviewed = new Date(reviewedUpdatedAt).getTime();
  if (Number.isNaN(reviewed)) return true;
  return reviewed !== new Date(currentUpdatedAt).getTime();
}

/**
 * The full effect of an owner's decision: the status the post moves to, the
 * approval state it then reads as, and — when approving — whether it keeps
 * its time or publishes immediately (see {@link approvalOutcome}).
 */
export function decideApproval(input: {
  decision: "approve" | "reject";
  scheduledFor: Date | string | null;
  now: Date;
  bufferMs: number;
}): {
  status: "scheduled" | "in_progress" | "cancelled";
  approvalState: "approved" | "rejected";
  outcome: "schedule" | "publish_now" | null;
} {
  if (input.decision === "reject") {
    return { status: "cancelled", approvalState: "rejected", outcome: null };
  }
  const outcome = approvalOutcome(input, input.now, input.bufferMs);
  return {
    status: outcome === "schedule" ? "scheduled" : "in_progress",
    approvalState: "approved",
    outcome,
  };
}

/**
 * What `POST /api/posts/[id]/cancel` writes. Cancelling a PENDING post is the
 * member withdrawing it (owners reject through the approval route), so the
 * submission stamp is cleared in the same write — otherwise
 * {@link deriveApprovalState} would read the cancelled, submitted, unapproved
 * row back as "rejected".
 */
export function cancelData(
  job: ApprovalFacts,
): { status: "cancelled"; submittedForApprovalAt?: null } {
  return deriveApprovalState(job) === "pending"
    ? { status: "cancelled", submittedForApprovalAt: null }
    : { status: "cancelled" };
}
