import { logger } from "@/lib/logger";

/**
 * Billing on or off, and a workspace's plan state (21a, 2026-11-10). Pure apart
 * from reading the environment and one log line. Everything billing changes is
 * behind billingEnabled(): with it off, every caller treats a workspace as it
 * did before billing existed.
 *
 * BILLING_STARTED_AT is what keeps workspaces created while billing was off
 * from being caught when it is switched on: anything created before it is
 * exempt, whatever its columns say. The operator sets it together with
 * BILLING_ENABLED, to the moment billing is switched on (never earlier: a
 * workspace created in between would have no trial).
 */

export type BillingEnv = Record<string, string | undefined>;

export type PlanState = "exempt" | "active" | "trial" | "ended";

/**
 * The Workspace billing columns plus its creation date. Optional, and a Date
 * or its ISO string, like the pause fields: a job step's memoized output
 * carries dates as strings, and a query with billing off does not read them.
 */
export type BillingFields = {
  createdAt?: Date | string | null;
  billingExempt?: boolean | null;
  plan?: string | null;
  planStatus?: string | null;
  trialEndsAt?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A card that fails gets a week after the period end before posting stops. */
export const PAST_DUE_GRACE_DAYS = 7;

export const DEFAULT_TRIAL_DAYS = 14;
export const MAX_TRIAL_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** BILLING_STARTED_AT as a date, or null when unset or not an ISO date. */
export function billingStartedAt(env: BillingEnv = process.env): Date | null {
  const raw = env.BILLING_STARTED_AT?.trim();
  if (!raw || !ISO_DATE.test(raw)) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  // "2026-02-30" parses as 2 March: refuse a calendar date that does not exist.
  if (date.toISOString().slice(0, 10) !== raw.slice(0, 10) && raw.length === 10) return null;
  return date;
}

let configErrorLogged = false;

/**
 * True only when BILLING_ENABLED is exactly "true" and BILLING_STARTED_AT is a
 * valid date. Read at request time, so a change needs no deploy. Enabled
 * without a valid start date counts as off: logged once per process as a
 * configuration error, never thrown.
 */
export function billingEnabled(env: BillingEnv = process.env): boolean {
  if (env.BILLING_ENABLED !== "true") return false;
  if (billingStartedAt(env)) return true;
  if (!configErrorLogged) {
    configErrorLogged = true;
    logger.error(
      "[billing] BILLING_ENABLED is true but BILLING_STARTED_AT is not a valid ISO date; billing stays off",
      { billingStartedAt: env.BILLING_STARTED_AT ?? null },
    );
  }
  return false;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Which state a workspace is in at `now`. `startedAt` is BILLING_STARTED_AT;
 * null means no start date applies (the admin page with billing off).
 */
export function planState(
  workspace: BillingFields,
  now: Date,
  startedAt: Date | null = billingStartedAt(),
): PlanState {
  if (workspace.billingExempt) return "exempt";
  const createdAt = toDate(workspace.createdAt);
  // A row read without its creation date cannot be shown to be new: never catch it.
  if (!createdAt) return "exempt";
  if (startedAt && createdAt < startedAt) return "exempt";

  if (workspace.plan) {
    if (workspace.planStatus === "active" || workspace.planStatus === "trialing") return "active";
    const periodEnd = toDate(workspace.currentPeriodEnd);
    if (
      workspace.planStatus === "past_due" &&
      periodEnd &&
      now.getTime() < periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS
    ) {
      return "active";
    }
    return "ended";
  }

  const trialEndsAt = toDate(workspace.trialEndsAt);
  if (trialEndsAt && trialEndsAt.getTime() > now.getTime()) return "trial";
  return "ended";
}

/** BILLING_TRIAL_DAYS: a whole number, 14 when unset or invalid, kept within 1 to 90. */
export function trialDays(env: BillingEnv = process.env): number {
  const raw = env.BILLING_TRIAL_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TRIAL_DAYS;
  return Math.min(MAX_TRIAL_DAYS, Math.max(1, Number(raw)));
}

/**
 * What a new workspace is created with: nothing extra with billing off (it is
 * created exactly as before), a trial and no exemption with it on.
 */
export function newWorkspaceBillingData(
  now: Date,
  env: BillingEnv = process.env,
): { trialEndsAt?: Date; billingExempt?: boolean } {
  if (!billingEnabled(env)) return {};
  return { trialEndsAt: new Date(now.getTime() + trialDays(env) * DAY_MS), billingExempt: false };
}

export const BILLING_FIELDS_SELECT = {
  createdAt: true,
  billingExempt: true,
  plan: true,
  planStatus: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
} as const;

/**
 * Spread into a Workspace select at an enforcement point: the billing columns
 * with billing on, nothing with it off, so a query with billing off is
 * exactly the one it was before.
 */
export function billingFieldsSelect(env: BillingEnv = process.env): Partial<typeof BILLING_FIELDS_SELECT> {
  return billingEnabled(env) ? BILLING_FIELDS_SELECT : {};
}

/** One word per state, for the operator's admin pages. */
export const PLAN_STATE_LABELS: Record<PlanState, string> = {
  exempt: "Exempt",
  active: "Active",
  trial: "Trial",
  ended: "Ended",
};
