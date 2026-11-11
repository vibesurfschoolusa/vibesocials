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
 * The pause columns, and the billing ones (createdAt among them). Optional,
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
  "createdAt",
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

export const TRIAL_ENDED_MESSAGE = "Your free trial has ended. Choose a plan in Settings to keep posting.";
export const PLAN_ENDED_MESSAGE = "Your plan has ended. Choose a plan in Settings to keep posting.";

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
