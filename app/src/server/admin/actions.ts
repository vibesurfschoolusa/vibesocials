import type { Prisma } from "@prisma/client";

import { MAX_TRIAL_DAYS } from "@/lib/billing";
import { prisma } from "@/lib/db";
import type { Operator } from "@/lib/operator";
import { utcDateLabel } from "@/lib/usageLimits";

/**
 * What the operator can change on /admin (2026-11-10): a workspace's limit
 * overrides, pause / resume, and (21a) its billing exemption and trial end. Each change and its AdminAction record are
 * written in one transaction that first takes the Workspace row lock, so two
 * operators (or two clicks) cannot both see "not paused" and both record a
 * pause. Nothing here deletes anything.
 */

export const LIMIT_FIELDS = [
  "limitPostsPerDay",
  "limitXPostsPerMonth",
  "limitYoutubeUploadsPerDay",
  "limitStorageMb",
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];
export type LimitChanges = Partial<Record<LimitField, number | null>>;

/** Sane upper bounds; zero is a real limit (it blocks everything). */
export const LIMIT_MAX: Record<LimitField, number> = {
  limitPostsPerDay: 100_000,
  limitXPostsPerMonth: 100_000,
  limitYoutubeUploadsPerDay: 100_000,
  limitStorageMb: 1_000_000,
};

export const PAUSE_REASON_MAX_LENGTH = 300;

type Invalid = { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The limits body: one or more of the four columns, each a whole number in bounds or null. */
export function validateLimitsBody(body: unknown): { ok: true; limits: LimitChanges } | Invalid {
  if (!isPlainObject(body)) return { ok: false, error: "Send the limits as a JSON object." };
  const known = new Set<string>(LIMIT_FIELDS);
  const unknown = Object.keys(body).filter((key) => !known.has(key));
  if (unknown.length > 0) return { ok: false, error: `Unknown field: ${unknown[0]}.` };

  const limits: LimitChanges = {};
  for (const field of LIMIT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) {
      limits[field] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMIT_MAX[field]) {
      return {
        ok: false,
        error: `${field} must be a whole number from 0 to ${LIMIT_MAX[field].toLocaleString("en-US")}, or empty for the default.`,
      };
    }
    limits[field] = value;
  }
  if (Object.keys(limits).length === 0) return { ok: false, error: "No limit to change." };
  return { ok: true, limits };
}

/** Control characters, including line breaks: the reason is one line of plain text. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The pause body: a reason the workspace's members will read, required. */
export function validatePauseBody(body: unknown): { ok: true; reason: string } | Invalid {
  if (!isPlainObject(body) || typeof body.reason !== "string") {
    return { ok: false, error: "Give a reason. The workspace's members will read it." };
  }
  const reason = body.reason.trim();
  if (!reason) return { ok: false, error: "Give a reason. The workspace's members will read it." };
  if (reason.length > PAUSE_REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason to ${PAUSE_REASON_MAX_LENGTH} characters.` };
  }
  if (CONTROL_CHARACTERS.test(reason)) return { ok: false, error: "Write the reason on one line." };
  return { ok: true, reason };
}

/** The exempt body: `{ exempt: true | false }`, nothing else. */
export function validateExemptBody(body: unknown): { ok: true; exempt: boolean } | Invalid {
  if (!isPlainObject(body) || typeof body.exempt !== "boolean" || Object.keys(body).length !== 1) {
    return { ok: false, error: "Send exempt as true or false." };
  }
  return { ok: true, exempt: body.exempt };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The trial body: `{ trialEndsAt: "YYYY-MM-DD" }` from today to MAX_TRIAL_DAYS
 * ahead (UTC calendar days), stored as the end of that UTC day so the trial
 * runs through the date shown; or `{ trialEndsAt: null }` to clear it.
 */
export function validateTrialBody(body: unknown, now: Date): { ok: true; trialEndsAt: Date | null } | Invalid {
  const shape = "Send trialEndsAt as a date (YYYY-MM-DD), or null to clear it.";
  if (!isPlainObject(body) || !("trialEndsAt" in body) || Object.keys(body).length !== 1) {
    return { ok: false, error: shape };
  }
  const value = body.trialEndsAt;
  if (value === null) return { ok: true, trialEndsAt: null };
  const match = typeof value === "string" ? DATE_ONLY.exec(value) : null;
  if (!match) return { ok: false, error: shape };

  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = new Date(Date.UTC(year, month, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month || start.getUTCDate() !== day) {
    return { ok: false, error: shape };
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const last = new Date(today + MAX_TRIAL_DAYS * DAY_MS);
  if (start.getTime() < today) return { ok: false, error: "Pick today or a later date." };
  if (start.getTime() > last.getTime()) {
    return {
      ok: false,
      error: `Pick a date at most ${MAX_TRIAL_DAYS} days ahead (${utcDateLabel(last)} or earlier).`,
    };
  }
  return { ok: true, trialEndsAt: new Date(start.getTime() + DAY_MS - 1) };
}

export type ChangeResult =
  | { status: "not_found" }
  | { status: "unchanged" }
  | { status: "changed" };

export type PauseChangeResult =
  | { status: "not_found" }
  | { status: "unchanged" }
  | { status: "changed"; actionId: string; workspaceName: string };

const LOCKED_ROW_SELECT = {
  id: true,
  name: true,
  limitPostsPerDay: true,
  limitXPostsPerMonth: true,
  limitYoutubeUploadsPerDay: true,
  limitStorageMb: true,
  pausedAt: true,
  pausedReason: true,
  billingExempt: true,
  trialEndsAt: true,
} satisfies Prisma.WorkspaceSelect;

type LockedRow = Prisma.WorkspaceGetPayload<{ select: typeof LOCKED_ROW_SELECT }>;

/** Lock the workspace row, read it, and let `change` decide what to write. */
async function withLockedWorkspace<T>(
  workspaceId: string,
  change: (tx: Prisma.TransactionClient, row: LockedRow) => Promise<T>,
): Promise<T | { status: "not_found" }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
    const row = await tx.workspace.findUnique({ where: { id: workspaceId }, select: LOCKED_ROW_SELECT });
    if (!row) return { status: "not_found" as const };
    return change(tx, row);
  });
}

function record(
  tx: Prisma.TransactionClient,
  operator: Operator,
  row: LockedRow,
  action: "limits" | "pause" | "resume" | "exempt" | "trial",
  detail: { old: Prisma.InputJsonObject; new: Prisma.InputJsonObject },
) {
  return tx.adminAction.create({
    data: {
      operatorUserId: operator.userId,
      operatorEmail: operator.email,
      workspaceId: row.id,
      workspaceName: row.name,
      action,
      detail,
    },
    select: { id: true },
  });
}

/** Set or clear limit overrides. Only the fields that actually change are written and recorded. */
export async function setWorkspaceLimits(args: {
  operator: Operator;
  workspaceId: string;
  limits: LimitChanges;
}): Promise<ChangeResult> {
  return withLockedWorkspace(args.workspaceId, async (tx, row) => {
    const before: LimitChanges = {};
    const after: LimitChanges = {};
    for (const field of LIMIT_FIELDS) {
      const next = args.limits[field];
      if (next === undefined || next === row[field]) continue;
      before[field] = row[field];
      after[field] = next;
    }
    if (Object.keys(after).length === 0) return { status: "unchanged" as const };

    await tx.workspace.update({ where: { id: row.id }, data: after });
    await record(tx, args.operator, row, "limits", { old: before, new: after });
    return { status: "changed" as const };
  });
}

/** Pause with a reason. Pausing a paused workspace changes and records nothing. */
export async function pauseWorkspace(args: {
  operator: Operator;
  workspaceId: string;
  reason: string;
  now: Date;
}): Promise<PauseChangeResult> {
  return withLockedWorkspace(args.workspaceId, async (tx, row) => {
    if (row.pausedAt) return { status: "unchanged" as const };

    await tx.workspace.update({
      where: { id: row.id },
      data: { pausedAt: args.now, pausedReason: args.reason },
    });
    const action = await record(tx, args.operator, row, "pause", {
      old: { pausedAt: null, pausedReason: row.pausedReason },
      new: { pausedAt: args.now.toISOString(), pausedReason: args.reason },
    });
    return { status: "changed" as const, actionId: action.id, workspaceName: row.name };
  });
}

/** Resume. Resuming a workspace that is not paused changes and records nothing. */
export async function resumeWorkspace(args: {
  operator: Operator;
  workspaceId: string;
}): Promise<PauseChangeResult> {
  return withLockedWorkspace(args.workspaceId, async (tx, row) => {
    if (!row.pausedAt) return { status: "unchanged" as const };

    await tx.workspace.update({ where: { id: row.id }, data: { pausedAt: null, pausedReason: null } });
    const action = await record(tx, args.operator, row, "resume", {
      old: { pausedAt: row.pausedAt.toISOString(), pausedReason: row.pausedReason },
      new: { pausedAt: null, pausedReason: null },
    });
    return { status: "changed" as const, actionId: action.id, workspaceName: row.name };
  });
}

/** Exempt a workspace from billing, or end the exemption. Setting what is already set records nothing. */
export async function setBillingExempt(args: {
  operator: Operator;
  workspaceId: string;
  exempt: boolean;
}): Promise<ChangeResult> {
  return withLockedWorkspace(args.workspaceId, async (tx, row) => {
    if (row.billingExempt === args.exempt) return { status: "unchanged" as const };

    await tx.workspace.update({ where: { id: row.id }, data: { billingExempt: args.exempt } });
    await record(tx, args.operator, row, "exempt", {
      old: { billingExempt: row.billingExempt },
      new: { billingExempt: args.exempt },
    });
    return { status: "changed" as const };
  });
}

/** Set or clear the end of the workspace's free trial. The bounds are checked by validateTrialBody. */
export async function setTrialEndsAt(args: {
  operator: Operator;
  workspaceId: string;
  trialEndsAt: Date | null;
}): Promise<ChangeResult> {
  return withLockedWorkspace(args.workspaceId, async (tx, row) => {
    if ((row.trialEndsAt?.getTime() ?? null) === (args.trialEndsAt?.getTime() ?? null)) {
      return { status: "unchanged" as const };
    }

    await tx.workspace.update({ where: { id: row.id }, data: { trialEndsAt: args.trialEndsAt } });
    await record(tx, args.operator, row, "trial", {
      old: { trialEndsAt: row.trialEndsAt?.toISOString() ?? null },
      new: { trialEndsAt: args.trialEndsAt?.toISOString() ?? null },
    });
    return { status: "changed" as const };
  });
}
