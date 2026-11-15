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
import { ownerDailyPostLimit, personalPostLimitApplies, type ReducedReason } from "@/lib/usageLimits";
import { planDateText } from "@/lib/workspaceStatus";

/**
 * What Settings → Plan says (21a): the workspace's plan state in words. Null
 * means the section is not rendered: billing off, or a member (owners only).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** R7-new-customer M1: a workspace with no plan and no trial that is not flagged exempt. */
export const NO_PLAN_YET_LABEL = "This workspace has no plan yet. The free limits apply until it has one.";

/**
 * R8-new-customer L4: such a workspace posts on the free limits now, but once
 * a plan it bought ends it stops posting (planState "ended"), so it is told
 * before checkout, beside the plan buttons.
 */
export const NO_PLAN_CANCEL_LATER_LINE = "If you cancel the plan later, this workspace stops posting until it has a plan again.";


/** Unflagged and never on a trial or a plan: made while billing was off, and free to buy one. */
function withoutPlanOrTrial(workspace: BillingFields, now: Date): boolean {
  return !workspace.billingExempt && planState(workspace, now) === "exempt";
}

/** An owner's workspace with no plan and no trial (made while billing was off): {@link NO_PLAN_CANCEL_LATER_LINE}. */
export function planNoPlanYet(role: "owner" | "member", workspace: BillingFields, now: Date): boolean {
  return role === "owner" && withoutPlanOrTrial(workspace, now);
}

/**
 * The viewer's own daily number across their workspaces, and why it is the
 * lower one when it is. R10-pages M1: untilFirstPayment, a plan not yet paid
 * for (in its card trial, or with no paid invoice recorded).
 */
export type PersonalPostNote = { limit: number; reduced: ReducedReason | null; untilFirstPayment?: boolean };

/** R10-pages M1: the Plan section's line for a plan not yet paid for, with the viewer's own number. */
export function planUntilFirstPaymentLine(limit: number): string {
  return `Until the first payment, posts here count toward your ${limit} a day.`;
}

/**
 * R8-new-customer L1: the Plan section's per-person note. Only where the
 * per-person limit counts this workspace's posts (not paying, not exempt,
 * not an operator's; lib/usageLimits.ts personalPostLimitApplies), with the
 * viewer's own number from the same rule the limit uses (ownerDailyPostLimit).
 * R10-pages M1: with billing on, a plan in use (planState "active") that the
 * limit still counts is one not yet paid for (paysForPlan), so the note says
 * it counts until the first payment.
 */
export function planPersonalPostNote(
  workspace: BillingFields,
  viewer: { emailVerifiedAt: Date | null; createdAt: Date },
  operatorOwned: boolean,
  now: Date,
  env: BillingEnv = process.env,
): PersonalPostNote | null {
  if (operatorOwned || !personalPostLimitApplies(workspace, env, now)) return null;
  const note = ownerDailyPostLimit(viewer, now);
  return billingEnabled(env) && planState(workspace, now) === "active" ? { ...note, untilFirstPayment: true } : note;
}

export function planSectionLabel(
  role: "owner" | "member",
  // 21b fix round 1: planEndsAt, when a plan set to cancel stops.
  workspace: BillingFields & { planEndsAt?: Date | string | null },
  now: Date,
  env: BillingEnv = process.env,
  // R13-new-customer L1: the viewer's User.timeZone; the dates are labelled UTC without one.
  timeZone: string | null = null,
): string | null {
  if (role !== "owner" || !billingEnabled(env)) return null;

  const state = planState(workspace, now);
  // Not "billed by invoice": a customer's own workspace can be exempt only because it predates billing.
  if (state === "exempt" && workspace.billingExempt) return "No plan is needed for this workspace.";
  // R7-new-customer M1: made while billing was off. The free limits hold it
  // (usageLog.ts), so it is offered the plans (planSectionActions).
  if (state === "exempt") return NO_PLAN_YET_LABEL;
  if (state === "ended") return workspace.plan ? "Your plan has ended" : "Your free trial has ended";

  if (state === "trial") {
    // planState is "trial" only with a valid trialEndsAt.
    return `Free trial until ${planDateText(toBillingDate(workspace.trialEndsAt) as Date, timeZone)}`;
  }

  const name = isPlanKey(workspace.plan) ? `${PLANS[workspace.plan].name} plan` : "Your plan";
  const periodEnd = toBillingDate(workspace.currentPeriodEnd);
  if (workspace.planStatus === "past_due" && periodEnd) {
    const stops = new Date(periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
    return `${name}. The last payment did not go through; posting stops on ${planDateText(stops, timeZone)}.`;
  }
  const endsAt = toBillingDate(workspace.planEndsAt);
  if (endsAt) return `${name}, ends on ${planDateText(endsAt, timeZone)}`;
  if (!periodEnd) return name;
  // A plan chosen during the free trial is "trialing" at Stripe until the trial
  // ends: nothing has been charged, so its period end is the first payment.
  if (workspace.planStatus === "trialing") return `${name}, first payment on ${planDateText(periodEnd, timeZone)}`;
  return `${name}, renews ${planDateText(periodEnd, timeZone)}`;
}

/** 21b fix round 1: the Plan section's line with billing off, when only the portal button shows. */
export const PLAN_PORTAL_ONLY_LABEL = "Your card, invoices and plan are with Stripe.";

/** 21b: the line after returning from Stripe Checkout, until the webhook has written the plan. */
export const PLAN_RETURN_NOTICE = "Thanks. Your plan appears here within a minute.";

/**
 * 21b: the Plan section's buttons, for owners. One per plan that has a price,
 * in a trial, ended or never on either (made while billing was off; not one
 * flagged exempt), only with payments configured. The customer portal
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
  // R7-new-customer M1: and one made while billing was off, as checkout allows.
  const choosable = state === "trial" || state === "ended" || withoutPlanOrTrial(workspace, now);
  const choose = paymentsConfigured(env) && choosable ? offeredPlans(env) : [];
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
