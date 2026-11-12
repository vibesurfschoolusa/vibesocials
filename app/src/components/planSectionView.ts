import {
  billingEnabled,
  offeredPlans,
  PAST_DUE_GRACE_DAYS,
  paymentsConfigured,
  planState,
  stripeReachable,
  toBillingDate,
  type BillingEnv,
  type BillingFields,
} from "@/lib/billing";
import { PLAN_FEATURES, planIncludes } from "@/lib/planFeatures";
import { isPlanKey, PLANS, type PlanKey } from "@/lib/plans";
import { utcDayMonthLabel } from "@/lib/usageLimits";

/**
 * What Settings → Plan says (21a): the workspace's plan state in words. Null
 * means the section is not rendered: billing off, or a member (owners only).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function planSectionLabel(
  role: "owner" | "member",
  // 21b fix round 1: planEndsAt, when a plan set to cancel stops.
  workspace: BillingFields & { planEndsAt?: Date | string | null },
  now: Date,
  env: BillingEnv = process.env,
): string | null {
  if (role !== "owner" || !billingEnabled(env)) return null;

  const state = planState(workspace, now);
  // Not "billed by invoice": a customer's own workspace can be exempt only because it predates billing.
  if (state === "exempt") return "No plan is needed for this workspace.";
  if (state === "ended") return workspace.plan ? "Your plan has ended" : "Your free trial has ended";

  if (state === "trial") {
    // planState is "trial" only with a valid trialEndsAt.
    return `Free trial until ${utcDayMonthLabel(toBillingDate(workspace.trialEndsAt) as Date)}`;
  }

  const name = isPlanKey(workspace.plan) ? `${PLANS[workspace.plan].name} plan` : "Your plan";
  const periodEnd = toBillingDate(workspace.currentPeriodEnd);
  if (workspace.planStatus === "past_due" && periodEnd) {
    const stops = new Date(periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
    return `${name}. The last payment did not go through; posting stops on ${utcDayMonthLabel(stops)}.`;
  }
  const endsAt = toBillingDate(workspace.planEndsAt);
  if (endsAt) return `${name}, ends on ${utcDayMonthLabel(endsAt)}`;
  return periodEnd ? `${name}, renews ${utcDayMonthLabel(periodEnd)}` : name;
}

/** 21b fix round 1: the Plan section's line with billing off, when only the portal button shows. */
export const PLAN_PORTAL_ONLY_LABEL = "Your card, invoices and plan are with Stripe.";

/** 21b: the line after returning from Stripe Checkout, until the webhook has written the plan. */
export const PLAN_RETURN_NOTICE = "Thanks. Your plan appears here within a minute.";

/**
 * 21b: the Plan section's buttons, for owners. One per plan that has a price,
 * in a trial or ended, only with payments configured. The customer portal
 * whenever the Stripe key is set and the workspace has a plan or a Stripe
 * customer, whatever its state and whether billing is on (fix round 1), so an
 * owner can always reach their card, invoices and cancel. Null: no buttons.
 */
export function planSectionActions(
  role: "owner" | "member",
  workspace: BillingFields & { stripeCustomerId?: string | null },
  now: Date,
  env: BillingEnv = process.env,
): { choose: PlanKey[]; manage: boolean } | null {
  if (role !== "owner" || !stripeReachable(env)) return null;
  const state = planState(workspace, now);
  const choose = paymentsConfigured(env) && (state === "trial" || state === "ended") ? offeredPlans(env) : [];
  const manage = Boolean(workspace.plan || workspace.stripeCustomerId);
  if (choose.length === 0 && !manage) return null;
  return { choose, manage };
}

/** The return line, only for `?billing=success` and only while the plan is not active yet. */
export function planReturnNotice(billingParam: string | undefined, workspace: BillingFields, now: Date): string | null {
  if (billingParam !== "success") return null;
  return planState(workspace, now) === "active" ? null : PLAN_RETURN_NOTICE;
}

/**
 * P1: whether Settings, Plan says what Growth adds: an owner whose workspace
 * is on an active plan that lacks a Growth feature, with billing on. Fix
 * round 2: asked of planIncludes, the one rule, not of the plan's name.
 */
export function planGrowthAddsShown(
  role: "owner" | "member",
  workspace: BillingFields,
  now: Date,
  env: BillingEnv = process.env,
): boolean {
  if (role !== "owner" || !billingEnabled(env) || planState(workspace, now) !== "active") return false;
  return PLAN_FEATURES.some((feature) => !planIncludes(workspace, feature, env, now));
}
