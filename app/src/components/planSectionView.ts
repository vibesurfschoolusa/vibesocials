import {
  billingEnabled,
  PAST_DUE_GRACE_DAYS,
  planState,
  toBillingDate,
  type BillingEnv,
  type BillingFields,
} from "@/lib/billing";
import { isPlanKey, PLANS } from "@/lib/plans";
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
  if (state === "exempt") return "Exempt: billed by invoice";
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
