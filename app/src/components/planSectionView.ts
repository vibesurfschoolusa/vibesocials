import {
  billingEnabled,
  offeredPlans,
  PAST_DUE_GRACE_DAYS,
  paymentsConfigured,
  planState,
  toBillingDate,
  type BillingEnv,
  type BillingFields,
} from "@/lib/billing";
import { isPlanKey, PLANS, type PlanKey } from "@/lib/plans";
import { utcDayMonthLabel } from "@/lib/usageLimits";

/**
 * What Settings → Plan says (21a): the workspace's plan state in words. Null
 * means the section is not rendered: billing off, or a member (owners only).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function planSectionLabel(
  role: "owner" | "member",
  workspace: BillingFields,
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
  return periodEnd ? `${name}, renews ${utcDayMonthLabel(periodEnd)}` : name;
}

/** 21b: the line after returning from Stripe Checkout, until the webhook has written the plan. */
export const PLAN_RETURN_NOTICE = "Thanks. Your plan appears here within a minute.";

/**
 * 21b: the Plan section's buttons. Null (no buttons) unless payments are
 * configured and the viewer is an owner. In a trial or ended: one button per
 * plan that has a price. With a plan (active or ended): the customer portal.
 */
export function planSectionActions(
  role: "owner" | "member",
  workspace: BillingFields,
  now: Date,
  env: BillingEnv = process.env,
): { choose: PlanKey[]; manage: boolean } | null {
  if (role !== "owner" || !paymentsConfigured(env)) return null;
  const state = planState(workspace, now);
  const choose = state === "trial" || state === "ended" ? offeredPlans(env) : [];
  const manage = Boolean(workspace.plan) && state !== "exempt";
  if (choose.length === 0 && !manage) return null;
  return { choose, manage };
}

/** The return line, only for `?billing=success` and only while the plan is not active yet. */
export function planReturnNotice(billingParam: string | undefined, workspace: BillingFields, now: Date): string | null {
  if (billingParam !== "success") return null;
  return planState(workspace, now) === "active" ? null : PLAN_RETURN_NOTICE;
}
