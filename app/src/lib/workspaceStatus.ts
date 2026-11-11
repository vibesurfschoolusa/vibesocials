import { NextResponse } from "next/server";

import { SUPPORT_EMAIL } from "./siteInfo";

/**
 * Whether a workspace may create or move work (2026-11-10). Today the only cause
 * is the operator's pause (/admin); a plan that has ended will be the second.
 * Every enforcement point calls workspaceBlock rather than reading the columns,
 * so a new cause reaches all of them at once.
 */

export const WORKSPACE_PAUSED_CODE = "WORKSPACE_PAUSED";

export type WorkspaceBlock = { code: typeof WORKSPACE_PAUSED_CODE; message: string };

/**
 * The pause columns. Optional, and a Date or its ISO string, because a job step's
 * memoized output carries dates as strings and a row read before the migration
 * has neither field.
 */
export type WorkspaceStatusFields = {
  pausedAt?: Date | string | null;
  pausedReason?: string | null;
};

export function workspacePausedMessage(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return `This workspace is paused. Contact ${SUPPORT_EMAIL}.`;
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `This workspace is paused: ${sentence} Contact ${SUPPORT_EMAIL}.`;
}

/** Null when the workspace may work; otherwise why not, in words its members read. */
export function workspaceBlock(workspace: WorkspaceStatusFields): WorkspaceBlock | null {
  if (!workspace.pausedAt) return null;
  return { code: WORKSPACE_PAUSED_CODE, message: workspacePausedMessage(workspace.pausedReason) };
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

/**
 * POST /api/workspaces refuses an owner of any blocked workspace, so a paused
 * customer cannot carry on in a new workspace in one click.
 */
export const CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE = `You cannot create a workspace while one of your workspaces is paused. Contact ${SUPPORT_EMAIL}.`;

/** For a route: the 403 to return as-is, or null to carry on. */
export function workspaceBlockResponse(workspace: WorkspaceStatusFields): NextResponse | null {
  const block = workspaceBlock(workspace);
  if (!block) return null;
  return NextResponse.json({ error: block.message, code: block.code }, { status: 403 });
}
