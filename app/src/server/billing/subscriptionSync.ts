import { planForPriceId, type BillingEnv } from "@/lib/billing";
import type { PlanKey } from "@/lib/plans";

import type { StripeId, StripeSubscription } from "./stripeApi";

/**
 * What the webhook writes onto a workspace (21b, fix round 3). Pure: the
 * caller fetches the event's subscription and lists the customer's
 * subscriptions from Stripe, reads the workspace, and writes the result in the
 * transaction that records the event.
 *
 * The rule: the workspace's state comes from the customer's whole list, not
 * from the one subscription an event is about. Whichever event is handled
 * last (and is not older than the last one written) writes the state Stripe
 * holds for every subscription of the workspace, so two subscriptions
 * changing close together cannot leave a stale state behind.
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

/** The statuses a workspace's plan works in (planState reads exactly these three as active). */
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

export function stripeIdOf(value: StripeId | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

export type SyncWorkspace = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingExempt: boolean;
  /** The created time of the newest event written (fix round 1). */
  stripeLastEventAt?: Date | null;
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
  stripeLastEventAt?: Date;
};

/** A candidate in use whose price is none of the three plan prices. */
export type UnconfiguredPrice = { subscriptionId: string; priceId: string | null };

export type SyncResult =
  | {
      ok: true;
      data: PlanWrite;
      warnings: string[];
      /** Candidates in use (active, trialing, past_due) with a known price, newest first. */
      liveCandidateIds: string[];
      unconfigured: UnconfiguredPrice[];
    }
  | { ok: false; level: "error" | "info"; reason: string; unconfigured: UnconfiguredPrice[] };

const fromUnixSeconds = (value: number | null | undefined): Date | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;

const priceOf = (s: StripeSubscription) => s.items?.data?.[0]?.price?.id ?? null;
const createdOf = (s: StripeSubscription) => s.created ?? 0;
const endedOf = (s: StripeSubscription) => s.ended_at ?? s.canceled_at ?? s.created ?? 0;

/** Newest first; ties broken by id, so every handler picks the same one. */
function newestBy(list: StripeSubscription[], time: (s: StripeSubscription) => number): StripeSubscription[] {
  return [...list].sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * 1. The workspace: it exists, and the event's subscription is on its stored
 *    customer, or it has no customer yet and the checkout session that made
 *    this subscription names it (the customer is then attached).
 * 2. The event is not older than the last one written.
 * 3. Candidates: the subscriptions in `list` on that customer whose metadata
 *    names this workspace.
 * 4. The effective one: among candidates in use (active, trialing, past_due)
 *    whose price maps to a plan, the most recently created. Otherwise the
 *    candidate that ended most recently (ended_at, else canceled_at, else
 *    created), whatever its price. No candidates: nothing is written.
 * 5. Its state is written: plan from its price, status (canceled for an ended
 *    one), the period date (the period's start while past_due, when the
 *    failed renewal was), trial end, plan end, its id.
 */
export function syncFromCustomerList(
  eventSubscription: StripeSubscription,
  workspace: SyncWorkspace | null,
  claim: CheckoutClaim | null,
  list: StripeSubscription[],
  env: BillingEnv = process.env,
  eventAt: Date | null = null,
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

  const lastWritten = workspace.stripeLastEventAt ?? null;
  if (lastWritten && (!eventAt || eventAt.getTime() < lastWritten.getTime())) {
    return refuse("info", "an event older than the one last written");
  }

  const candidates = list.filter(
    (s) => stripeIdOf(s.customer) === customer && s.metadata?.workspaceId === workspace.id,
  );
  const inUse = candidates.filter((s) => IN_USE.has(s.status));
  const unconfigured = inUse
    .filter((s) => planForPriceId(priceOf(s), env) === null)
    .map((s) => ({ subscriptionId: s.id, priceId: priceOf(s) }));
  const live = newestBy(
    inUse.filter((s) => planForPriceId(priceOf(s), env) !== null),
    createdOf,
  );
  const ended = newestBy(
    candidates.filter((s) => !IN_USE.has(s.status)),
    endedOf,
  );
  const effective = live[0] ?? ended[0] ?? null;
  if (!effective) {
    return refuse(
      "error",
      candidates.length === 0
        ? "no subscription of the customer names this workspace"
        : "no subscription in use has a plan price, and none has ended",
      unconfigured,
    );
  }

  const isLive = IN_USE.has(effective.status);
  const item = effective.items?.data?.[0];
  const periodEnd = fromUnixSeconds(item?.current_period_end);
  // Stripe starts the new period before it tries the card, so a past_due
  // subscription's period end is the end of the unpaid period. The grace in
  // planState runs from currentPeriodEnd, so it gets the failed renewal's
  // date: the start of that period (fix round 1).
  const currentPeriodEnd =
    effective.status === "past_due" ? (fromUnixSeconds(item?.current_period_start) ?? periodEnd) : periodEnd;
  const data: PlanWrite = {
    planStatus: isLive ? effective.status : "canceled",
    currentPeriodEnd,
    planEndsAt: effective.cancel_at_period_end ? periodEnd : fromUnixSeconds(effective.cancel_at),
    stripeSubscriptionId: effective.id,
  };
  const plan = planForPriceId(priceOf(effective), env);
  if (plan) data.plan = plan;
  const trialEnd = fromUnixSeconds(effective.trial_end);
  if (trialEnd) data.trialEndsAt = trialEnd;
  if (bindCustomer) data.stripeCustomerId = customer;
  if (eventAt) data.stripeLastEventAt = eventAt;

  const warnings = workspace.billingExempt
    ? ["the workspace is exempt by its flag, so it keeps the default limits until the operator clears the exemption"]
    : [];
  return { ok: true, data, warnings, liveCandidateIds: live.map((s) => s.id), unconfigured };
}
