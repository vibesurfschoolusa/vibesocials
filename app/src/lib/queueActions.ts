import { answerLostText } from "./answerLost";
import { approvalOutcome } from "./approval";
import { dispatchFailedText } from "./composerSubmitOutcome";
import { isRouteAnswer } from "./postSubmitFailure";
import { fetchOrNoAnswer, isNoAnswer } from "./requestNoAnswer";
import type { Platform } from "@prisma/client";
import type { PostJobDTO } from "./postsDto";
import { POST_GONE_TEXT } from "./postMovedOn";
import { storyChoiceSuffix, storyPlatformLabel } from "./storyPlacement";
import { localDateTimeToUtcIso, SCHEDULED_TIME_TOO_SOON_MESSAGE, toDateTimeLocalValue } from "./scheduling";
import { INVALID_WORKSPACE_ID_CODE, MISSING_WORKSPACE_ID_CODE, WORKSPACE_CHANGED_CODE } from "./workspaceChanged";

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

/**
 * Copy for the card's confirm dialog, by what the primary action does.
 * R58 publishing-flow L3: a draft can target some platforms only, so the
 * dialog names the ones the post lists; "connected" is only for a post with
 * no targets, which goes to every connected platform. R59 publishing-flow L3:
 * a Story is labelled as the card labels it (storyPlatformLabel, storyChoiceSuffix).
 */
export function publishConfirmCopy(
  kind: QueuePrimaryAction["kind"],
  targets: readonly Platform[] | null = null,
  storyPlatforms: readonly Platform[] = [],
): {
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
    description: `It will be sent to ${targetNames(targets, storyPlatforms)} right away instead of waiting.`,
    confirmText: "Publish now",
  };
}

/** "Instagram", "Instagram (Story) and X", "Instagram, X and LinkedIn"; no targets: every connected platform. */
function targetNames(targets: readonly Platform[] | null, storyPlatforms: readonly Platform[]): string {
  if (!targets?.length) return `your connected platforms${storyChoiceSuffix(storyPlatforms)}`;
  const labels = targets.map((platform) => storyPlatformLabel(platform, storyPlatforms));
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
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
  Pick<PostJobDTO, "status" | "approvalState" | "scheduledFor" | "caption" | "clientApprovedAt">
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
 * R57 client-journey L1: a route that cleared the client's approval answers
 * `clientApprovedAt: null`, and the card drops its badge. An answer without
 * it leaves the card as it is.
 */
function clientApprovalWithdrawn(r: Record<string, unknown>): JobPatch {
  return r.clientApprovedAt === null ? { clientApprovedAt: null } : {};
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
      patch: { status: "scheduled", ...(scheduledFor ? { scheduledFor } : {}), ...clientApprovalWithdrawn(r) },
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
  const r = asRecord(data);
  if (decision === "reject") {
    // R23-client-journey L4: the route's `authorEmail` says whether the email
    // went out; without it nothing is claimed.
    const message =
      r.authorEmail === "sent"
        ? "Post rejected — the author has been notified."
        : r.authorEmail === "removed"
          ? "Post rejected. The author is no longer in this workspace, so no email was sent."
          : r.authorEmail === "failed"
            ? "Post rejected. We couldn't email the author; let them know yourself."
            : "Post rejected.";
    return { kind: "remove", message };
  }
  if (r.status === "scheduled") {
    const scheduledFor = isoOrNull(r.scheduledFor);
    return {
      kind: "update",
      patch: {
        status: "scheduled",
        approvalState: "approved",
        ...(scheduledFor ? { scheduledFor } : {}),
        ...clientApprovalWithdrawn(r),
      },
      message: "Approved — it will publish at its scheduled time.",
    };
  }
  return { kind: "remove", message: "Approved — publishing now" };
}

/**
 * `PATCH /api/posts/{id}` 2xx. Only a member's edit of a scheduled post
 * answers `approvalState: "pending"` (it was re-held); anything else is a plain
 * save. The caller adds the caption / time it sent. `clientApprovedAt: null`
 * (R56 client-journey-2 L1): the edit or drag withdrew the client's approval.
 */
export function editOutcome(data: unknown): { patch: JobPatch; message: string } {
  const r = asRecord(data);
  const withdrawn: JobPatch = r.clientApprovedAt === null ? { clientApprovedAt: null } : {};
  if (r.approvalState === "pending") {
    return {
      patch: { status: "draft", approvalState: "pending", ...withdrawn },
      message: "Changes saved — sent back for approval.",
    };
  }
  return { patch: withdrawn, message: "Changes saved." };
}

/**
 * R31 publishing L3-L5 and pages L2: the one rule for a refused post action,
 * on every page (the Queue's Cancel, Cancel series, Publish now, Approve,
 * Reject, Delete, Edit and calendar drag; Activity's Retry and Send again).
 *
 * - The page is for another workspace (409 WORKSPACE_CHANGED), or from before
 *   the release (400 MISSING_WORKSPACE_ID / INVALID_WORKSPACE_ID): its sentence,
 *   and no reload, which would read the other workspace's posts into this page.
 * - The post moved on since the page was drawn (any other 409, a 404, a 400
 *   NOT_SCHEDULED for a post that is now a draft, or the 503 DISPATCH_FAILED
 *   after the claim): the route's sentence (a 404 always "This post no longer
 *   exists.") and a quiet reload, so no dead buttons stay.
 * - Anything else: the route's sentence, or `fallback`; the card stays.
 *
 * `button` (Publish now, Approve) words a DISPATCH_FAILED by Create's rule.
 */
export interface PostActionRefusal {
  /** The page is out of date for this post: a dialog closes (Edit keeps what was typed). */
  movedOn: boolean;
  /** Read the list again quietly. */
  reload: boolean;
  text: string;
}

const OTHER_WORKSPACE_CODES = new Set<unknown>([WORKSPACE_CHANGED_CODE, MISSING_WORKSPACE_ID_CODE, INVALID_WORKSPACE_ID_CODE]);

export function postActionRefusal(
  httpStatus: number,
  data: unknown,
  fallback: string,
  button?: "Publish" | "Approve",
): PostActionRefusal {
  const r = asRecord(data);
  const said = typeof r.error === "string" && r.error ? r.error : fallback;
  if (OTHER_WORKSPACE_CODES.has(r.code)) return { movedOn: true, reload: false, text: said };
  const text = button ? queueFailureText(data, fallback, button) : said;
  if (httpStatus === 404) return { movedOn: true, reload: true, text: POST_GONE_TEXT };
  if (httpStatus === 409 || httpStatus === 503 || (httpStatus === 400 && r.code === "NOT_SCHEDULED")) {
    return { movedOn: true, reload: true, text };
  }
  return { movedOn: false, reload: false, text };
}

/**
 * R26 LL3: what a failed Publish now or Approve says. Publishing couldn't
 * start after the post was claimed: Create's sentences (dispatchFailedText),
 * so the person retries from Activity rather than pressing again. Anything
 * else: the route's sentence, or `fallback`.
 */
export function queueFailureText(data: unknown, fallback: string, button: "Publish" | "Approve"): string {
  const r = asRecord(data);
  if (r.code === "DISPATCH_FAILED") return dispatchFailedText(data, button);
  return typeof r.error === "string" && r.error ? r.error : fallback;
}

/* ----- a press whose answer may be lost ----- */

/**
 * R27 publishing-flow L3 = pages L10: what came of an action request.
 * - `not_sent`: the browser was offline, so nothing left; it is safe to press again.
 * - `no_answer`: the fetch rejected, or a 5xx that isn't the route's own JSON
 *   (a gateway's 502/504 page) came back. The server may have done it, so the
 *   person checks before pressing again (postSubmitFailure's isRouteAnswer).
 * - `answer`: the route's answer, to be read as usual.
 */
export type ActionAnswer = { kind: "answer"; response: Response } | { kind: "not_sent" } | { kind: "no_answer" };

/** False only when the browser says it is offline: then nothing is sent. */
export function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export async function sendActionRequest(
  url: string,
  init: RequestInit,
  deps: { fetchImpl?: typeof fetch; online?: () => boolean } = {},
): Promise<ActionAnswer> {
  if (!(deps.online ?? browserOnline)()) return { kind: "not_sent" };
  let response: Response;
  try {
    response = await fetchOrNoAnswer(url, init, deps.fetchImpl ?? fetch);
  } catch (error) {
    if (isNoAnswer(error)) return { kind: "no_answer" };
    throw error;
  }
  if (response.status >= 500 && !(await isRouteAnswer(response))) return { kind: "no_answer" };
  return { kind: "answer", response };
}

/** The Queue's presses that change a post. */
export type QueueAction = "approve" | "reject" | "publish" | "submit" | "schedule" | "edit";

const NOT_SENT: Record<QueueAction, [what: string, next: string]> = {
  approve: ["the post wasn't approved", "press Approve again"],
  reject: ["the post wasn't rejected", "press Reject again"],
  publish: ["the post wasn't published", "press Publish now again"],
  submit: ["the post wasn't sent for approval", "press Submit for approval again"],
  schedule: ["the post wasn't scheduled", "press Save and schedule again"],
  edit: ["your changes weren't saved", "save again"],
};

/** Offline, nothing sent: the connection sentence. */
export function queueNotSentText(action: QueueAction): string {
  const [what, next] = NOT_SENT[action];
  return `We couldn't reach Vibe Socials, so ${what}. Check your connection and ${next}.`;
}

const MAY_HAVE: Record<QueueAction, [what: string, check: string]> = {
  approve: ["the post may have been approved", "check it and Activity before you press Approve again"],
  reject: ["the post may have been rejected", "check it before you press Reject again"],
  publish: ["the post may have started publishing", "check Activity before you press Publish now again"],
  submit: ["the post may have been sent for approval", "check it before you press Submit for approval again"],
  schedule: ["the post may have been scheduled", "check it before you press Save and schedule again"],
  edit: ["your changes may have been saved", "check the post before you save again"],
};

/**
 * No answer: it may have gone through. The caller starts a reload of the
 * Queue, so the text says it is reloading (true whether or not that reload
 * succeeds) rather than that it has.
 */
export function queueMayHaveGoneThroughText(action: QueueAction): string {
  const [what, check] = MAY_HAVE[action];
  return answerLostText(what, `We're reloading the Queue: ${check}.`);
}

/**
 * R27 publishing-flow L2 = pages L2: Approve and Reject each show their own
 * press. The pressed one spins (Button's loading keeps focus on it); the other
 * is aria-disabled, never disabled, so focus never drops.
 */
export function decisionButtonState(
  deciding: "approve" | "reject" | null,
  button: "approve" | "reject",
): { loading: boolean; "aria-disabled": true | undefined } {
  return { loading: deciding === button, "aria-disabled": deciding !== null || undefined };
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
    return { ok: false, error: SCHEDULED_TIME_TOO_SOON_MESSAGE };
  }
  return { ok: true, iso };
}

/**
 * The time the Edit dialog sends, or `iso: null` to leave it out. A scheduled post
 * whose field still shows its stored time sends none, so a due post the scanner
 * hasn't picked up yet can still get a caption fix (R59 publishing-flow-2 L1);
 * only a changed time is checked as now. A draft sends any time chosen, since
 * choosing one is what schedules it.
 */
export function editTimeToSend(input: {
  scheduled: boolean;
  field: string;
  savedScheduledFor: string | null;
  nowMs: number;
  bufferMs: number;
}): { ok: true; iso: string | null } | { ok: false; error: string } {
  if (input.scheduled) {
    const unchanged =
      input.savedScheduledFor !== null && input.field === toDateTimeLocalValue(new Date(input.savedScheduledFor));
    if (unchanged) return { ok: true, iso: null };
  } else if (!input.field) {
    return { ok: true, iso: null };
  }
  const check = checkScheduleTime(input.field, input.nowMs, input.bufferMs);
  return check.ok ? { ok: true, iso: check.iso } : check;
}
