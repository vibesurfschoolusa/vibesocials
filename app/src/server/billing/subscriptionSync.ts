import { planForPriceId, type BillingEnv } from "@/lib/billing";
import type { PlanKey } from "@/lib/plans";

import type { StripeId, StripeSubscription } from "./stripeApi";

/**
 * What the webhook writes onto a workspace (21b, fix round 4). Pure: the
 * webhook locks the workspace row, fetches the event's subscription and the
 * customer's whole list from Stripe while it holds the lock, and writes the
 * result in the same transaction. Handlers for one workspace cannot overlap,
 * and each reads Stripe's current state, so whichever runs last writes the
 * latest state, whatever order the events came in.
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

/** The statuses a plan works in; planState reads exactly these three as active. */
const IN_USE = new Set(["active", "trialing", "past_due"]);

/**
 * A subscription Stripe may still bill or revive (checkout and deletion use
 * this). Only canceled and incomplete_expired are terminal; an unknown
 * status counts as not live.
 */
export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return (
    typeof status === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(status) &&
    status !== "canceled" &&
    status !== "incomplete_expired"
  );
}

/** A subscription that is not in use (active, trialing, past_due) has ended, as far as the plan goes. */
export function isInUse(status: string | null | undefined): boolean {
  return typeof status === "string" && IN_USE.has(status);
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
  /** The stored plan; kept when the stored subscription's price is no longer configured. */
  plan?: string | null;
};

/** What a checkout.session.completed event says: this session, for this workspace, made this subscription. */
export type CheckoutClaim = { workspaceId: string | null; customer: string | null; subscription: string | null };

export type PlanWrite = {
  /** Absent when an ended subscription's price maps to no plan: the stored plan stays. */
  plan?: PlanKey;
  planStatus: string;
  currentPeriodEnd: Date | null;
  /** When a plan set to cancel stops; null when it renews. */
  planEndsAt: Date | null;
  trialEndsAt?: Date;
  stripeSubscriptionId: string;
  stripeCustomerId?: string;
};

/** A candidate in use whose price is none of the three plan prices. */
export type UnconfiguredPrice = { subscriptionId: string; priceId: string | null };

export type SyncResult =
  | {
      ok: true;
      data: PlanWrite;
      warnings: string[];
      /** Candidates in use, in the order they were ranked. */
      liveCandidateIds: string[];
      unconfigured: UnconfiguredPrice[];
      /** The stored subscription in use on a price no longer configured: its stored plan is kept (a warning). */
      keptPlan: UnconfiguredPrice[];
    }
  | { ok: false; level: "error" | "info"; reason: string; unconfigured: UnconfiguredPrice[] };

const fromUnixSeconds = (value: number | null | undefined): Date | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;

const priceOf = (s: StripeSubscription) => s.items?.data?.[0]?.price?.id ?? null;
const byId = (a: StripeSubscription, b: StripeSubscription) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** active and trialing ahead of past_due. */
const usePriority = (s: StripeSubscription) => (s.status === "past_due" ? 1 : 0);
const endedOf = (s: StripeSubscription) => s.ended_at ?? s.canceled_at ?? s.created ?? 0;

/**
 * 1. The workspace exists, and the event's subscription is on its stored
 *    customer, or it has no customer yet and the checkout session that made
 *    this subscription names it (the customer is then attached).
 * 2. The list must be complete (every page read).
 * 3. Candidates: the event's subscription, merged by id over the list, and
 *    every listed subscription on that customer whose metadata names this
 *    workspace.
 * 4. A candidate in use (active, trialing, past_due) whose price maps to no
 *    plan: if it is the workspace's stored subscription and the workspace has
 *    a stored plan, it stays a candidate and keeps that plan, so a subscriber
 *    left on an old price keeps the plan they bought while their payment
 *    state follows Stripe (fix round 5). Any other such candidate means
 *    nothing is written: a paying customer on a price the app does not know
 *    must not be written as ended or as a wrong plan.
 * 5. The effective one: the candidate in use ranked first by active or
 *    trialing ahead of past_due, then the most recently created (ties to the
 *    larger id). With none in use, the candidate that ended most recently
 *    (ended_at, else canceled_at, else created). No candidates: nothing.
 * 6. Its state is written: plan from its price when it maps (else the stored
 *    plan stays), Stripe's own status, the period date (the period's start
 *    while past_due, which is when the last paid period ended), trial end,
 *    plan end, its id.
 */
export function syncFromCustomerList(
  eventSubscription: StripeSubscription,
  workspace: SyncWorkspace | null,
  claim: CheckoutClaim | null,
  list: StripeSubscription[],
  env: BillingEnv = process.env,
  listComplete = true,
): SyncResult {
  const refuse = (level: "error" | "info", reason: string, unconfigured: UnconfiguredPrice[] = []): SyncResult => ({
    ok: false,
    level,
    reason,
    unconfigured,
  });
  if (!workspace) return refuse("error", "the workspace named in the subscription does not exist");

  const customer = stripeIdOf(eventSubscription.customer);
  if (!customer) return refuse("error", "the subscription has no customer");
  let bindCustomer = false;
  if (workspace.stripeCustomerId !== customer) {
    const claimed =
      workspace.stripeCustomerId === null &&
      claim !== null &&
      claim.workspaceId === workspace.id &&
      claim.customer === customer &&
      claim.subscription === eventSubscription.id;
    if (!claimed) return refuse("error", "the subscription's customer is not this workspace's");
    bindCustomer = true;
  }

  if (!listComplete) return refuse("error", "the customer has more subscriptions than were read");

  const merged = new Map(list.map((s) => [s.id, s]));
  merged.set(eventSubscription.id, eventSubscription);
  const candidates = [...merged.values()].filter(
    (s) => stripeIdOf(s.customer) === customer && s.metadata?.workspaceId === workspace.id,
  );

  const inUse = candidates.filter((s) => isInUse(s.status));
  const unknownPrice = inUse.filter((s) => planForPriceId(priceOf(s), env) === null);
  const keepsStoredPlan = (s: StripeSubscription) => s.id === workspace.stripeSubscriptionId && Boolean(workspace.plan);
  const asPrice = (s: StripeSubscription) => ({ subscriptionId: s.id, priceId: priceOf(s) });
  const keptPlan = unknownPrice.filter(keepsStoredPlan).map(asPrice);
  const unconfigured = unknownPrice.filter((s) => !keepsStoredPlan(s)).map(asPrice);
  if (unconfigured.length > 0) {
    return refuse("error", "a subscription in use has a price that is none of the plan prices", unconfigured);
  }

  const ranked = [...inUse].sort(
    (a, b) => usePriority(a) - usePriority(b) || (b.created ?? 0) - (a.created ?? 0) || byId(a, b),
  );
  const ended = candidates
    .filter((s) => !isInUse(s.status))
    .sort((a, b) => endedOf(b) - endedOf(a) || byId(a, b));
  const effective = ranked[0] ?? ended[0] ?? null;
  if (!effective) return refuse("error", "no subscription of the customer names this workspace");

  const item = effective.items?.data?.[0];
  const periodEnd = fromUnixSeconds(item?.current_period_end);
  // Stripe starts the new period before it tries the card, so a past_due
  // subscription's period end is the end of the unpaid period. The grace in
  // planState runs from currentPeriodEnd, so it gets the start of that
  // period: when the last paid one ended (fix round 1).
  const currentPeriodEnd =
    effective.status === "past_due" ? (fromUnixSeconds(item?.current_period_start) ?? periodEnd) : periodEnd;
  const data: PlanWrite = {
    planStatus: effective.status,
    currentPeriodEnd,
    planEndsAt: effective.cancel_at_period_end ? periodEnd : fromUnixSeconds(effective.cancel_at),
    stripeSubscriptionId: effective.id,
  };
  const plan = planForPriceId(priceOf(effective), env);
  if (plan) data.plan = plan;
  const trialEnd = fromUnixSeconds(effective.trial_end);
  if (trialEnd) data.trialEndsAt = trialEnd;
  if (bindCustomer) data.stripeCustomerId = customer;

  const warnings = workspace.billingExempt
    ? ["the workspace is exempt by its flag, so it keeps the default limits until the operator clears the exemption"]
    : [];
  return { ok: true, data, warnings, liveCandidateIds: ranked.map((s) => s.id), unconfigured, keptPlan };
}
