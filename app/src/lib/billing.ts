/**
 * Billing on or off, and a workspace's plan state (21a, 2026-11-10). Pure apart
 * from reading the environment. Everything billing changes is behind
 * billingEnabled(): with it off, every caller treats a workspace as it did
 * before billing existed.
 *
 * The rule that makes switching billing on safe (fix round 1): a workspace can
 * be "ended" only if it was offered a trial or had a plan. Only creation with
 * billing on writes a trial (src/server/billing/newWorkspaceTrial.ts) and only
 * the payment provider writes a plan, so a workspace created while billing was
 * off has neither and stays exempt, whenever billing is switched on.
 */

export type BillingEnv = Record<string, string | undefined>;

export type PlanState = "exempt" | "active" | "trial" | "ended";

/**
 * The Workspace billing columns. Optional, and a Date or its ISO string, like
 * the pause fields: a job step's memoized output carries dates as strings, and
 * a query with billing off does not read them.
 */
export type BillingFields = {
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

/** True exactly when BILLING_ENABLED is "true". Read at request time, so a change needs no deploy. */
export function billingEnabled(env: BillingEnv = process.env): boolean {
  return env.BILLING_ENABLED === "true";
}

/** A Date or ISO string as a date; null when missing or unparseable. */
export function toBillingDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Which state a workspace is in at `now`, in this order: exempt by its flag;
 * exempt with no plan and no (parseable) trial date; active on a plan that is
 * active or trialing, or past_due less than 7 days after its period end; in
 * trial with no plan and a trial date in the future; ended otherwise.
 */
export function planState(workspace: BillingFields, now: Date): PlanState {
  if (workspace.billingExempt) return "exempt";

  const trialEndsAt = toBillingDate(workspace.trialEndsAt);
  // Never offered a trial and never on a plan: only creation with billing off makes this row.
  if (!workspace.plan && !trialEndsAt) return "exempt";

  if (workspace.plan) {
    if (workspace.planStatus === "active" || workspace.planStatus === "trialing") return "active";
    const periodEnd = toBillingDate(workspace.currentPeriodEnd);
    if (
      workspace.planStatus === "past_due" &&
      periodEnd &&
      now.getTime() < periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS
    ) {
      return "active";
    }
    return "ended";
  }

  return trialEndsAt && trialEndsAt.getTime() > now.getTime() ? "trial" : "ended";
}

/** BILLING_TRIAL_DAYS: a whole number, 14 when unset or invalid, kept within 1 to 90. */
export function trialDays(env: BillingEnv = process.env): number {
  const raw = env.BILLING_TRIAL_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TRIAL_DAYS;
  return Math.min(MAX_TRIAL_DAYS, Math.max(1, Number(raw)));
}

export const BILLING_FIELDS_SELECT = {
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
