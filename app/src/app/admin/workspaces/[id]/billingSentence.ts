import { PAST_DUE_GRACE_DAYS, planState, toBillingDate, type BillingFields } from "@/lib/billing";
import { utcDateLabel } from "@/lib/usageLimits";

/**
 * The admin page's billing sentences (21a, fix round 1): whether billing is
 * enforced, and what the stored fields mean, so each is true for every state.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function adminBillingLines(
  billing: BillingFields & { enabled: boolean },
  now: Date,
): { enforcement: string; state: string } {
  const enforcement = billing.enabled ? "Billing is on. This state is enforced." : "Billing is off. Nothing is enforced.";
  return { enforcement, state: stateSentence(billing, now) };
}

function stateSentence(billing: BillingFields, now: Date): string {
  const state = planState(billing, now);
  if (state === "exempt") {
    return billing.billingExempt
      ? "Exempt: never blocked for its plan, and on the default limits."
      : "Exempt: it was never offered a trial and has no plan (it was created while billing was off), so it is never blocked for its plan.";
  }
  if (state === "trial") {
    const endsAt = toBillingDate(billing.trialEndsAt) as Date;
    return `In a free trial until ${utcDateLabel(endsAt)}, on the Starter limits. Posting stops then unless a plan is chosen.`;
  }
  if (state === "active") {
    const periodEnd = toBillingDate(billing.currentPeriodEnd);
    if (billing.planStatus === "past_due" && periodEnd) {
      const stops = new Date(periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
      return `On a plan whose last payment failed. Posting stops on ${utcDateLabel(stops)} unless it is paid.`;
    }
    return "On a plan, with that plan's limits.";
  }
  return "Ended: with billing on it cannot upload, create, schedule or publish, like a paused workspace. Posts that come due are marked failed and can be retried once a plan is active. Nothing is charged or deleted.";
}
