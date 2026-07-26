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
