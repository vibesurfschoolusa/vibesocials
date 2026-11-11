import { stripeReachable, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

import {
  cancelSubscription,
  listCustomerSubscriptions,
  retrieveSubscription,
  STRIPE_TIMEOUT_MS,
  StripeApiError,
} from "./stripeApi";
import { isLiveSubscriptionStatus } from "./subscriptionSync";

/**
 * Deleting a workspace or an account cancels its subscriptions at Stripe
 * first (21b), so nobody keeps paying for a workspace that is gone. Called by
 * the two delete routes before their transaction.
 *
 * Runs whenever the Stripe secret key is set, whatever BILLING_ENABLED says
 * (fix round 1): switching billing off must not leave an owner paying. Without
 * the key it returns at once and reads nothing, so deletion is as before.
 *
 * Stripe is asked for each customer's subscriptions (not only the one the
 * webhook stored), so a plan paid for moments ago is cancelled too. All the
 * Stripe calls share one 20-second budget. Cancelling is the point of no
 * return: if anything fails after a cancel, nothing is deleted and the
 * sentence says how many plans were cancelled; a retry skips those, because
 * Stripe no longer lists them as live.
 */

export const CANCEL_FAILED_MESSAGE =
  "We could not cancel your plan, so nothing was deleted. Try again, or cancel it under Settings, Plan first.";
/** Put before a refusal's own sentence when the refusal comes after a cancel. */
export const CANCELLED_WORKSPACE_KEPT_PREFIX = "Your plan was cancelled but the workspace could not be deleted.";
export const CANCELLED_WORKSPACE_KEPT_MESSAGE = `${CANCELLED_WORKSPACE_KEPT_PREFIX} Try again.`;
export const CANCELLED_ACCOUNT_KEPT_PREFIX = "Your plan was cancelled but your account could not be deleted.";
export const CANCELLED_ACCOUNT_KEPT_MESSAGE = `${CANCELLED_ACCOUNT_KEPT_PREFIX} Try again.`;

/** Every Stripe call of one deletion, together. */
export const CANCEL_PHASE_BUDGET_MS = 20_000;

export function partialCancelMessage(cancelled: number): string {
  return `${cancelled} of your plans were cancelled, but we could not finish. Nothing was deleted. Try again.`;
}

export type CancelResult = { ok: true; cancelled: number } | { ok: false; status: 409 | 502; error: string };

function logFailure(what: string, workspaceId: string, error: unknown) {
  logger.error(`[billing] ${what} before deletion failed`, {
    workspaceId,
    status: error instanceof StripeApiError ? error.status : null,
    code: error instanceof StripeApiError ? error.code : null,
    name: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * `precheck` runs only when something must be cancelled, before the first
 * cancel: the route's own refusal checks, so a deletion that would be refused
 * anyway cancels nothing. Its sentence is returned as a 409.
 */
export async function cancelSubscriptionsBeforeDelete(
  workspaceIds: string[],
  opts: { precheck?: () => Promise<string | null>; now?: () => number } = {},
  env: BillingEnv = process.env,
): Promise<CancelResult> {
  if (!stripeReachable(env) || workspaceIds.length === 0) return { ok: true, cancelled: 0 };
  const now = opts.now ?? Date.now;

  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds }, stripeCustomerId: { not: null } },
    select: { id: true, stripeCustomerId: true, stripeSubscriptionId: true, plan: true },
  });
  if (workspaces.length === 0) return { ok: true, cancelled: 0 };

  const deadline = now() + CANCEL_PHASE_BUDGET_MS;
  const budget = () => Math.min(STRIPE_TIMEOUT_MS, deadline - now());
  const failed = (cancelled: number): CancelResult => ({
    ok: false,
    status: 502,
    error: cancelled > 0 ? partialCancelMessage(cancelled) : CANCEL_FAILED_MESSAGE,
  });

  const live: Array<{ workspaceId: string; subscriptionId: string }> = [];
  for (const workspace of workspaces) {
    if (budget() <= 0) {
      logger.error("[billing] Ran out of time reading subscriptions before deletion", { workspaceId: workspace.id });
      return failed(0);
    }
    try {
      const subscriptions = await listCustomerSubscriptions(workspace.stripeCustomerId!, env, budget());
      for (const s of subscriptions) {
        if (isLiveSubscriptionStatus(s.status)) live.push({ workspaceId: workspace.id, subscriptionId: s.id });
      }
    } catch (error) {
      // Never subscribed (only a customer from an unfinished checkout): an
      // outage must not stop the deletion (fix round 1).
      if (!workspace.stripeSubscriptionId && !workspace.plan) {
        logger.warn("[billing] Could not read subscriptions; the workspace never had one, so deleting anyway", {
          workspaceId: workspace.id,
        });
        continue;
      }
      logFailure("Reading the subscriptions", workspace.id, error);
      return failed(0);
    }
  }
  if (live.length === 0) return { ok: true, cancelled: 0 };

  const refusal = opts.precheck ? await opts.precheck() : null;
  if (refusal) return { ok: false, status: 409, error: refusal };

  let cancelled = 0;
  for (const { workspaceId, subscriptionId } of live) {
    if (budget() <= 0) {
      logger.error("[billing] Ran out of time cancelling subscriptions before deletion", { workspaceId, cancelled });
      return failed(cancelled);
    }
    try {
      await cancelSubscription(subscriptionId, env, budget());
    } catch (error) {
      // Already cancelled (by the owner, or a retry of this request) counts as done.
      const left = budget();
      const current = left > 0 ? await retrieveSubscription(subscriptionId, env, left).catch(() => null) : null;
      if (!current || isLiveSubscriptionStatus(current.status)) {
        logFailure("Cancelling a subscription", workspaceId, error);
        return failed(cancelled);
      }
    }
    cancelled++;
  }
  logger.info("[billing] Subscriptions cancelled before deletion", { workspaceIds, cancelled });
  return { ok: true, cancelled };
}
