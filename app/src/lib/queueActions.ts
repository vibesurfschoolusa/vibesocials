import { approvalOutcome } from "./approval";
import type { PostJobDTO } from "./postsDto";
import { localDateTimeToUtcIso } from "./scheduling";

/**
 * Queue action / label rules (2026-11-01 audit, Task 2).
 *
 * The server now enforces owner approval, so the Queue must say what a click
 * will actually do: a member in an approval workspace SUBMITS a post instead of
 * publishing it, and editing a scheduled post sends it back for review. These
 * pure rules mirror `publishApprovalAction` / `editApprovalEffect`
 * (lib/approval.ts) using only what the list DTO exposes, so queue-view.tsx
 * stays a thin renderer.
 */

/** Who is looking: their role and whether the workspace requires approval. */
export interface QueueViewer {
  /** `null` until the first list response arrives; never treated as a member. */
  role: "owner" | "member" | null;
  requireApproval: boolean;
}

type JobFacts = Pick<PostJobDTO, "status" | "approvalState">;

/** A member of a workspace that requires approval — the only held viewer. */
function isApprovalMember(viewer: QueueViewer): boolean {
  return viewer.requireApproval && viewer.role === "member";
}

/**
 * Will "publish now" / "schedule" on this job be a SUBMISSION for approval?
 * Mirrors `needsApproval` on the server: members under approval, unless an
 * owner already approved this post.
 */
export function publishNeedsApproval(job: JobFacts, viewer: QueueViewer): boolean {
  return isApprovalMember(viewer) && job.approvalState !== "approved";
}

/**
 * Will EDITING this job send it back for approval? Mirrors `editApprovalEffect`
 * "rehold": any scheduled post a member under approval edits — approved or not
 * — goes back to the owners, because the cron would otherwise publish text no
 * one reviewed.
 */
export function editSendsBackForApproval(job: JobFacts, viewer: QueueViewer): boolean {
  return isApprovalMember(viewer) && job.status === "scheduled";
}

export const SUBMIT_FOR_APPROVAL_LABEL = "Submit for approval";
export const SENT_BACK_NOTICE = "Saving changes sends this post back for approval.";

export type QueuePrimaryAction =
  | { kind: "publish"; label: "Publish now" }
  | { kind: "submit"; label: "Submit for approval" };

export interface QueueCardActions {
  /** Owner on a pending post: Approve / Reject (+ hint). */
  decide: boolean;
  /** Non-owner on a pending post: read-only "waiting for an owner" note. */
  awaitingNote: boolean;
  edit: boolean;
  primary: QueuePrimaryAction | null;
  secondary: "cancel" | "delete" | null;
}

/**
 * Which actions a Queue card renders. A pending post gets its own row (the
 * normal Edit/Publish/Delete row is suppressed so nobody side-steps review);
 * everything else gets Edit + a primary action + Cancel (scheduled) or Delete.
 */
export function getQueueCardActions(job: JobFacts, viewer: QueueViewer): QueueCardActions {
  if (job.approvalState === "pending") {
    const owner = viewer.role === "owner";
    return {
      decide: owner,
      awaitingNote: !owner,
      edit: false,
      primary: null,
      secondary: null,
    };
  }
  return {
    decide: false,
    awaitingNote: false,
    edit: true,
    primary: publishNeedsApproval(job, viewer)
      ? { kind: "submit", label: SUBMIT_FOR_APPROVAL_LABEL }
      : { kind: "publish", label: "Publish now" },
    secondary: job.status === "scheduled" ? "cancel" : "delete",
  };
}

export type QueueBadgeTone = "warning" | "success" | "secondary" | "neutral";

/** The status pill: label + tone (a subset of the Badge component's variants). */
export function queueStatusBadge(job: JobFacts): { label: string; tone: QueueBadgeTone } {
  if (job.approvalState === "pending") return { label: "Awaiting approval", tone: "warning" };
  if (job.status === "scheduled") {
    return job.approvalState === "approved"
      ? { label: "Approved · Scheduled", tone: "success" }
      : { label: "Scheduled", tone: "secondary" };
  }
  return { label: "Draft", tone: "neutral" };
}

/** Copy for the card's confirm dialog, by what the primary action does. */
export function publishConfirmCopy(kind: QueuePrimaryAction["kind"]): {
  title: string;
  description: string;
  confirmText: string;
} {
  if (kind === "submit") {
    return {
      title: "Submit for approval?",
      description: "An owner will review this post before it publishes.",
      confirmText: SUBMIT_FOR_APPROVAL_LABEL,
    };
  }
  return {
    title: "Publish this post now?",
    description: "It will be sent to your connected platforms right away instead of waiting.",
    confirmText: "Publish now",
  };
}

/**
 * The owner's hint next to Approve. Uses the SAME rule the server applies
 * (`approvalOutcome`), so it never promises a scheduled time that approving
 * would not keep.
 */
export function approveHint(
  job: { scheduledFor: string | null },
  now: Date,
  bufferMs: number,
  formatTime: (iso: string) => string,
): string {
  if (!job.scheduledFor) return "Approving publishes it now.";
  return approvalOutcome(job, now, bufferMs) === "schedule"
    ? `Approving keeps its scheduled time (${formatTime(job.scheduledFor)}).`
    : "Its scheduled time has passed — approving publishes it now.";
}

/* ----- response handling: what a successful server answer does to the card ----- */

export type JobPatch = Partial<
  Pick<PostJobDTO, "status" | "approvalState" | "scheduledFor" | "caption">
>;

export type QueueOutcome =
  | { kind: "update"; patch: JobPatch; message: string }
  | { kind: "remove"; message: string };

function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Merge a patch into a job, ignoring `undefined` fields (explicit `null` applies). */
export function applyJobPatch(job: PostJobDTO, patch: JobPatch): PostJobDTO {
  const next = { ...job } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as PostJobDTO;
}

/**
 * `POST /api/posts/{id}/publish` 2xx. A member's submission (202, pending)
 * keeps the card in the list as a pending draft; scheduling a draft (200)
 * turns it into a scheduled card; publishing now (202, in_progress) removes it.
 */
export function publishOutcome(data: unknown): QueueOutcome {
  const r = asRecord(data);
  if (r.approvalState === "pending") {
    return {
      kind: "update",
      patch: { status: "draft", approvalState: "pending", scheduledFor: isoOrNull(r.scheduledFor) },
      message: "Sent for approval",
    };
  }
  if (r.status === "scheduled") {
    const scheduledFor = isoOrNull(r.scheduledFor);
    return {
      kind: "update",
      patch: { status: "scheduled", ...(scheduledFor ? { scheduledFor } : {}) },
      message: "Post scheduled.",
    };
  }
  return { kind: "remove", message: "Publishing now — track it in Activity." };
}

/**
 * `POST /api/posts/{id}/approval` 200. Approving a future-dated post keeps it
 * (scheduled, approved) in the list and calendar; publishing-now and rejecting
 * both leave the scheduled/draft Queue.
 */
export function decisionOutcome(decision: "approve" | "reject", data: unknown): QueueOutcome {
  if (decision === "reject") {
    return { kind: "remove", message: "Post rejected — the author has been notified." };
  }
  const r = asRecord(data);
  if (r.status === "scheduled") {
    const scheduledFor = isoOrNull(r.scheduledFor);
    return {
      kind: "update",
      patch: {
        status: "scheduled",
        approvalState: "approved",
        ...(scheduledFor ? { scheduledFor } : {}),
      },
      message: "Approved — it will publish at its scheduled time.",
    };
  }
  return { kind: "remove", message: "Approved — publishing now" };
}

/**
 * `PATCH /api/posts/{id}` 2xx. Only a member's edit of a scheduled post
 * answers `approvalState: "pending"` (it was re-held); anything else is a plain
 * save. The caller adds the caption / time it sent.
 */
export function editOutcome(data: unknown): { patch: JobPatch; message: string } {
  const r = asRecord(data);
  if (r.approvalState === "pending") {
    return {
      patch: { status: "draft", approvalState: "pending" },
      message: "Changes saved — sent back for approval.",
    };
  }
  return { patch: {}, message: "Changes saved." };
}

/**
 * After a failed decision / publish, is the card we're showing stale (someone
 * else decided, the post changed, it was deleted, or the dispatch failed after
 * the approval stood)? If so the Queue re-fetches instead of leaving dead
 * buttons. 409 = NOT_PENDING_APPROVAL / CHANGED_SINCE_REVIEW / NO_CONNECTIONS /
 * AWAITING_APPROVAL / NOT_PUBLISHABLE; 503 = DISPATCH_FAILED; 404 = gone.
 */
export function shouldRefetchAfterError(httpStatus: number): boolean {
  return httpStatus === 409 || httpStatus === 503 || httpStatus === 404;
}

/* ----- the Edit dialog ----- */

export interface EditDialogModel {
  title: string;
  scheduleLabel: string;
  scheduleRequired: boolean;
  /** One-line notice shown above the footer, or null. */
  notice: string | null;
}

export function editDialogModel(job: JobFacts, viewer: QueueViewer): EditDialogModel {
  if (job.status === "scheduled") {
    return {
      title: "Edit scheduled post",
      scheduleLabel: "Publish at",
      scheduleRequired: true,
      notice: editSendsBackForApproval(job, viewer) ? SENT_BACK_NOTICE : null,
    };
  }
  return {
    title: "Edit draft",
    scheduleLabel: "Schedule for (optional)",
    scheduleRequired: false,
    notice: null,
  };
}

/** The dialog's save button. A draft given a time is a submission for a held member. */
export function editSaveLabel(job: JobFacts, viewer: QueueViewer, hasScheduleTime: boolean): string {
  if (job.status === "scheduled" || !hasScheduleTime) return "Save changes";
  return publishNeedsApproval(job, viewer) ? SUBMIT_FOR_APPROVAL_LABEL : "Save and schedule";
}

/** Did the caption change (ignoring surrounding whitespace)? */
export function captionChanged(original: string | null, next: string): boolean {
  return (original ?? "").trim() !== next.trim();
}

/**
 * Validate a `datetime-local` value as a schedulable time (valid, and at least
 * `bufferMs` from `nowMs`). The server re-validates; this is the early, friendly
 * check shared by the scheduled and draft paths of the Edit dialog.
 */
export function checkScheduleTime(
  localValue: string,
  nowMs: number,
  bufferMs: number,
): { ok: true; iso: string } | { ok: false; error: string } {
  const iso = localDateTimeToUtcIso(localValue);
  if (!iso) return { ok: false, error: "Choose a valid date and time." };
  if (new Date(iso).getTime() < nowMs + bufferMs) {
    return { ok: false, error: "Scheduled time must be at least a minute in the future." };
  }
  return { ok: true, iso };
}
