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

import { PLAN_KEYS, type PlanKey } from "./plans";

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

/**
 * True exactly when BILLING_ENABLED is "true". Routes read it per request, but
 * the Terms, Privacy and Register pages are built at deploy time, so switching
 * billing on or off takes effect with the next deployment.
 */
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

/** How often a plan is paid for (P1): each plan has a monthly and, optionally, a yearly price. */
export const BILLING_INTERVALS = ["month", "year"] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** The environment variable holding each plan's Stripe price ids, per interval (21b; yearly P1). */
const PRICE_ENV: Record<BillingInterval, Record<PlanKey, string>> = {
  month: { starter: "STRIPE_PRICE_STARTER", growth: "STRIPE_PRICE_GROWTH", pro: "STRIPE_PRICE_PRO" },
  year: { starter: "STRIPE_PRICE_STARTER_YEARLY", growth: "STRIPE_PRICE_GROWTH_YEARLY", pro: "STRIPE_PRICE_PRO_YEARLY" },
};

function envValue(env: BillingEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * Each plan's Stripe price ids for one interval, monthly by default (fix
 * round 7; yearly P1). A variable holds one id or several separated by
 * commas; spaces are ignored and empty entries dropped. Every id in a plan's
 * list maps to that plan; the first is the one a new checkout uses and the
 * one Settings shows. So a price change puts the new id first and keeps the
 * old one after it, and subscribers on the old price are still recognised.
 * Everything that reads these variables goes through this function.
 */
export function planPriceIds(
  env: BillingEnv = process.env,
  interval: BillingInterval = "month",
): Record<PlanKey, string[]> {
  const parse = (plan: PlanKey) => [
    ...new Set(
      (env[PRICE_ENV[interval][plan]] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  return { starter: parse("starter"), growth: parse("growth"), pro: parse("pro") };
}

/**
 * Ids listed in more than one of the six lists (three plans, two intervals): a
 * configuration error; each maps to no plan. A Stripe price has one interval,
 * so an id under both a monthly and a yearly variable is one too.
 */
export function duplicatePriceIds(env: BillingEnv = process.env): string[] {
  const seen = new Map<string, number>();
  for (const interval of BILLING_INTERVALS) {
    const lists = planPriceIds(env, interval);
    for (const plan of PLAN_KEYS) for (const id of lists[plan]) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * The price id a new checkout uses for the plan and interval (the first in its
 * list that is not also listed elsewhere), or null: not offered that way.
 */
export function priceIdForPlan(
  plan: PlanKey,
  env: BillingEnv = process.env,
  interval: BillingInterval = "month",
): string | null {
  const duplicates = new Set(duplicatePriceIds(env));
  return planPriceIds(env, interval)[plan].find((id) => !duplicates.has(id)) ?? null;
}

/** The plans that have a usable price for the interval (monthly by default), in plan order. */
export function offeredPlans(env: BillingEnv = process.env, interval: BillingInterval = "month"): PlanKey[] {
  return PLAN_KEYS.filter((plan) => priceIdForPlan(plan, env, interval) !== null);
}

/**
 * Which plan a Stripe price id stands for: any id in a plan's monthly or
 * yearly list, unless it is listed twice. The webhook writes this plan.
 */
export function planForPriceId(priceId: string | null | undefined, env: BillingEnv = process.env): PlanKey | null {
  if (!priceId) return null;
  if (duplicatePriceIds(env).includes(priceId)) return null;
  for (const interval of BILLING_INTERVALS) {
    const lists = planPriceIds(env, interval);
    const plan = PLAN_KEYS.find((key) => lists[key].includes(priceId));
    if (plan) return plan;
  }
  return null;
}

/**
 * The app can talk to Stripe: the secret key is set (fix round 1). Whatever
 * BILLING_ENABLED says, so switching billing off never leaves an owner paying
 * for a workspace they delete, and the customer portal still opens.
 */
export function stripeReachable(env: BillingEnv = process.env): boolean {
  return envValue(env, "STRIPE_SECRET_KEY") !== null;
}

/**
 * The webhook handles events: both secrets are set (fix round 1). Whatever
 * BILLING_ENABLED says, so Stripe keeps delivering and the plan columns stay
 * true while billing is off.
 */
export function stripeWebhookConfigured(env: BillingEnv = process.env): boolean {
  return stripeReachable(env) && envValue(env, "STRIPE_WEBHOOK_SECRET") !== null;
}

/**
 * Starting a checkout, the plan buttons and the trial emails: billing on,
 * both secrets set and at least one plan with a price (21b). With it false
 * no one can start paying.
 */
export function paymentsConfigured(env: BillingEnv = process.env): boolean {
  return billingEnabled(env) && stripeWebhookConfigured(env) && offeredPlans(env).length > 0;
}
