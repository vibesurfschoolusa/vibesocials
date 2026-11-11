import { planForPriceId, type BillingEnv } from "@/lib/billing";
import type { PlanKey } from "@/lib/plans";

import type { StripeId, StripeSubscription } from "./stripeApi";

/**
 * What the webhook writes onto a workspace from a subscription it has just
 * fetched from Stripe (21b). Pure: the caller reads the workspace the
 * subscription's metadata names and writes the result in the transaction
 * that records the event.
 */

/** Every status the Subscription object documents for the pinned API version. */
export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

/**
 * A subscription Stripe may still bill or revive. Only canceled and
 * incomplete_expired are terminal; an unknown status counts as not live here
 * and is refused by subscriptionWrite.
 */
export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return (
    typeof status === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(status) &&
    status !== "canceled" &&
    status !== "incomplete_expired"
  );
}

export function stripeIdOf(value: StripeId | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

export type SyncWorkspace = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingExempt: boolean;
};

/** What a checkout.session.completed event says: this session, for this workspace, made this subscription. */
export type CheckoutClaim = { workspaceId: string | null; customer: string | null; subscription: string | null };

export type PlanWrite = {
  plan: PlanKey;
  planStatus: string;
  currentPeriodEnd: Date | null;
  /** When a plan set to cancel stops; null when it renews. */
  planEndsAt: Date | null;
  trialEndsAt?: Date;
  stripeSubscriptionId: string;
  stripeCustomerId?: string;
};

export type SyncResult =
  | { ok: true; data: PlanWrite; warnings: string[] }
  | { ok: false; level: "error" | "info"; reason: string };

const fromUnixSeconds = (value: number | null | undefined): Date | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;

/**
 * Accepted only when the workspace exists and its customer is the
 * subscription's, or it has no customer yet and the checkout session that
 * made this subscription names it. A subscription other than the one the
 * workspace holds replaces it only while live, so an ended one's late event
 * cannot overwrite a newer plan.
 */
export function subscriptionWrite(
  subscription: StripeSubscription,
  workspace: SyncWorkspace | null,
  claim: CheckoutClaim | null,
  env: BillingEnv = process.env,
): SyncResult {
  if (!workspace) return { ok: false, level: "error", reason: "the workspace named in the subscription does not exist" };

  const customer = stripeIdOf(subscription.customer);
  let bindCustomer = false;
  if (!customer) return { ok: false, level: "error", reason: "the subscription has no customer" };
  if (workspace.stripeCustomerId !== customer) {
    const claimed =
      workspace.stripeCustomerId === null &&
      claim !== null &&
      claim.workspaceId === workspace.id &&
      claim.customer === customer &&
      claim.subscription === subscription.id;
    if (!claimed) return { ok: false, level: "error", reason: "the subscription's customer is not this workspace's" };
    bindCustomer = true;
  }

  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)) {
    return { ok: false, level: "error", reason: "unknown subscription status" };
  }

  if (
    workspace.stripeSubscriptionId &&
    workspace.stripeSubscriptionId !== subscription.id &&
    !isLiveSubscriptionStatus(subscription.status)
  ) {
    return { ok: false, level: "info", reason: "an ended subscription that is not the workspace's current one" };
  }

  const item = subscription.items?.data?.[0];
  const plan = planForPriceId(item?.price?.id ?? null, env);
  if (!plan) return { ok: false, level: "error", reason: "the subscription's price is not one of the plan prices" };

  const periodEnd = fromUnixSeconds(item?.current_period_end);
  // Stripe starts the new period before it tries the card, so a past_due
  // subscription's period end is the end of the unpaid period. The grace in
  // planState runs from currentPeriodEnd, so it gets the failed renewal's
  // date: the start of that period (fix round 1).
  const currentPeriodEnd =
    subscription.status === "past_due" ? (fromUnixSeconds(item?.current_period_start) ?? periodEnd) : periodEnd;
  const planEndsAt = subscription.cancel_at_period_end ? periodEnd : fromUnixSeconds(subscription.cancel_at);
  const data: PlanWrite = {
    plan,
    planStatus: subscription.status,
    currentPeriodEnd,
    planEndsAt,
    stripeSubscriptionId: subscription.id,
  };
  const trialEnd = fromUnixSeconds(subscription.trial_end);
  if (trialEnd) data.trialEndsAt = trialEnd;
  if (bindCustomer) data.stripeCustomerId = customer;

  const warnings = workspace.billingExempt
    ? ["the workspace is exempt by its flag, so it keeps the default limits until the operator clears the exemption"]
    : [];
  return { ok: true, data, warnings };
}
