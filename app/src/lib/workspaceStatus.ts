import { NextResponse } from "next/server";

import { billingEnabled, planState, type BillingFields } from "./billing";
import { SUPPORT_EMAIL } from "./siteInfo";
import { utcDayMonthLabel } from "./usageLimits";

/**
 * Whether a workspace may create or move work (2026-11-10). Two causes: the
 * operator's pause (/admin), and, with billing on only, a trial or plan that
 * has ended (21a). Every enforcement point calls workspaceBlock rather than
 * reading the columns, so a new cause reaches all of them at once.
 */

export const WORKSPACE_PAUSED_CODE = "WORKSPACE_PAUSED";
export const PLAN_ENDED_CODE = "PLAN_ENDED";

export type WorkspaceBlockCode = typeof WORKSPACE_PAUSED_CODE | typeof PLAN_ENDED_CODE;

export type WorkspaceBlock = { code: WorkspaceBlockCode; message: string };

/**
 * The pause columns, and the billing ones. Optional,
 * and a Date or its ISO string, because a job step's memoized output carries
 * dates as strings, a row read before the migration has none of them, and an
 * enforcement point reads the billing ones only with billing on.
 */
export type WorkspaceStatusFields = {
  pausedAt?: Date | string | null;
  pausedReason?: string | null;
} & BillingFields;

const STATUS_KEYS = [
  "pausedAt",
  "pausedReason",
  "billingExempt",
  "plan",
  "planStatus",
  "trialEndsAt",
  "currentPeriodEnd",
] as const satisfies readonly (keyof WorkspaceStatusFields)[];

type StatusKey = (typeof STATUS_KEYS)[number];

export function workspacePausedMessage(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return `This workspace is paused. Contact ${SUPPORT_EMAIL}.`;
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `This workspace is paused: ${sentence} Contact ${SUPPORT_EMAIL}.`;
}

// Until payments exist (21b) there is nothing to click, so both name who to contact.
export const TRIAL_ENDED_MESSAGE = `Your free trial has ended. Choose a plan in Settings to keep posting, or contact ${SUPPORT_EMAIL}.`;
export const PLAN_ENDED_MESSAGE = `Your plan has ended. Choose a plan in Settings to keep posting, or contact ${SUPPORT_EMAIL}.`;

/** Null when the workspace may work; otherwise why not, in words its members read. The pause wins. */
export function workspaceBlock(workspace: WorkspaceStatusFields, now: Date = new Date()): WorkspaceBlock | null {
  if (workspace.pausedAt) {
    return { code: WORKSPACE_PAUSED_CODE, message: workspacePausedMessage(workspace.pausedReason) };
  }
  if (!billingEnabled() || planState(workspace, now) !== "ended") return null;
  return { code: PLAN_ENDED_CODE, message: workspace.plan ? PLAN_ENDED_MESSAGE : TRIAL_ENDED_MESSAGE };
}

/**
 * What the publish and retry functions write on a paused workspace's pending
 * results. A result failed this way is retryable after a resume; nothing
 * publishes it by itself later.
 */
export const WORKSPACE_PAUSED_RESULT_FAILURE = {
  errorCode: WORKSPACE_PAUSED_CODE,
  errorMessage: "Not published: this workspace was paused.",
} as const;

/** The same for a workspace whose trial or plan has ended; retryable once a plan is active. */
export const PLAN_ENDED_RESULT_FAILURE = {
  errorCode: PLAN_ENDED_CODE,
  errorMessage: "Not published: this workspace has no active plan.",
} as const;

export function blockedResultFailure(
  code: WorkspaceBlockCode,
): typeof WORKSPACE_PAUSED_RESULT_FAILURE | typeof PLAN_ENDED_RESULT_FAILURE {
  return code === PLAN_ENDED_CODE ? PLAN_ENDED_RESULT_FAILURE : WORKSPACE_PAUSED_RESULT_FAILURE;
}

/**
 * Splits a Workspace row into the status columns workspaceBlock reads and the
 * rest. The publish and retry steps memoize only the rest, so their output for
 * a workspace that is not blocked is the same with billing on or off.
 */
export function splitWorkspaceStatus<T extends WorkspaceStatusFields>(
  row: T,
): { status: WorkspaceStatusFields; rest: Omit<T, StatusKey> } {
  const status: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if ((STATUS_KEYS as readonly string[]).includes(key)) status[key] = value;
    else rest[key] = value;
  }
  return { status: status as WorkspaceStatusFields, rest: rest as Omit<T, StatusKey> };
}

const TRIAL_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The quieter line owners see in the last 3 days of a free trial, or null.
 * Only with billing on; members never see it.
 */
export function trialEndingNotice(
  workspace: WorkspaceStatusFields,
  role: "owner" | "member",
  now: Date = new Date(),
): string | null {
  if (role !== "owner" || !billingEnabled() || planState(workspace, now) !== "trial") return null;
  // planState is "trial" only with a valid trialEndsAt.
  const endsAt = new Date(workspace.trialEndsAt as Date | string);
  if (endsAt.getTime() - now.getTime() > TRIAL_NOTICE_MS) return null;
  return `Your free trial ends on ${utcDayMonthLabel(endsAt)}. Choose a plan in Settings.`;
}

/**
 * POST /api/workspaces refuses an owner of any blocked workspace, so a paused
 * customer cannot carry on in a new workspace in one click.
 */
export const CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE = `You cannot create a workspace while one of your workspaces is paused. Contact ${SUPPORT_EMAIL}.`;

const CREATE_WORKSPACE_WHILE_PLAN_ENDED_MESSAGE =
  "You cannot create a workspace while one of your workspaces has no active plan. Choose a plan in Settings first.";

export function createWorkspaceWhileBlockedMessage(code: WorkspaceBlockCode): string {
  return code === PLAN_ENDED_CODE ? CREATE_WORKSPACE_WHILE_PLAN_ENDED_MESSAGE : CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE;
}

/** For a route: the 403 to return as-is, or null to carry on. */
export function workspaceBlockResponse(
  workspace: WorkspaceStatusFields,
  now: Date = new Date(),
): NextResponse | null {
  const block = workspaceBlock(workspace, now);
  if (!block) return null;
  return NextResponse.json({ error: block.message, code: block.code }, { status: 403 });
}

export const EMAIL_UNCONFIRMED_CODE = "EMAIL_UNCONFIRMED";

export type AccessBlock = { code: WorkspaceBlockCode | typeof EMAIL_UNCONFIRMED_CODE; message: string };

/** The person's side of the check: the signed-in user's own row. */
export type AccessUser = { email: string; emailVerifiedAt: Date | null; googleLinkedAt: Date | null };

export function emailUnconfirmedMessage(email: string): string {
  return `Confirm your email address to start posting. We sent a link to ${email}.`;
}

/**
 * Whether the app can send the confirmation link: the same test GET
 * /api/auth/account-status answers as `verificationAvailable`, and the one the
 * register and resend routes use before minting a link.
 */
export function emailVerificationAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/**
 * Whether this person may create or move work in this workspace (23): the
 * workspace's block first, then, with billing on only, an unconfirmed email
 * address while the workspace is on its free trial. Registration stays open,
 * so this keeps a stranger's unconfirmed account from posting for free. It
 * does not apply (fix round 1):
 * - on a paid plan: a card was charged, and an existing customer who never had
 *   to confirm would otherwise be refused the moment they paid;
 * - when the app cannot send email, since no link could ever arrive;
 * - in an exempt workspace, or for a Google sign-in, which proves the mailbox.
 */
export function accessBlock(
  context: { user: AccessUser; workspace: WorkspaceStatusFields },
  now: Date = new Date(),
): AccessBlock | null {
  const block = workspaceBlock(context.workspace, now);
  if (block) return block;
  const { user } = context;
  if (!billingEnabled() || user.emailVerifiedAt || user.googleLinkedAt) return null;
  if (!emailVerificationAvailable() || planState(context.workspace, now) !== "trial") return null;
  return { code: EMAIL_UNCONFIRMED_CODE, message: emailUnconfirmedMessage(user.email) };
}

/** For a route that creates or moves work: the 403 to return as-is, or null to carry on. */
export function accessBlockResponse(
  context: { user: AccessUser; workspace: WorkspaceStatusFields },
  now: Date = new Date(),
): NextResponse | null {
  const block = accessBlock(context, now);
  if (!block) return null;
  return NextResponse.json({ error: block.message, code: block.code }, { status: 403 });
}
