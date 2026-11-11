import { paymentsConfigured, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

import { cancelSubscription, listCustomerSubscriptions, retrieveSubscription, StripeApiError } from "./stripeApi";
import { isLiveSubscriptionStatus } from "./subscriptionSync";

/**
 * Deleting a workspace or an account cancels its subscriptions at Stripe
 * first (21b), so nobody keeps paying for a workspace that is gone. Called by
 * the two delete routes before their transaction. With payments not
 * configured it returns at once, reading nothing, so deletion is as before.
 *
 * Stripe is asked for each customer's subscriptions (not only the one the
 * webhook stored), so a plan paid for moments ago is cancelled too.
 * Cancelling is the point of no return: if the delete fails afterwards, the
 * routes say so with the "plan was cancelled" sentences below.
 */

export const CANCEL_FAILED_MESSAGE =
  "We could not cancel your plan, so nothing was deleted. Try again, or cancel it under Settings, Plan first.";
/** Put before a refusal's own sentence when the refusal comes after a cancel. */
export const CANCELLED_WORKSPACE_KEPT_PREFIX = "Your plan was cancelled but the workspace could not be deleted.";
export const CANCELLED_WORKSPACE_KEPT_MESSAGE = `${CANCELLED_WORKSPACE_KEPT_PREFIX} Try again.`;
export const CANCELLED_ACCOUNT_KEPT_PREFIX = "Your plan was cancelled but your account could not be deleted.";
export const CANCELLED_ACCOUNT_KEPT_MESSAGE = `${CANCELLED_ACCOUNT_KEPT_PREFIX} Try again.`;

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
  opts: { precheck?: () => Promise<string | null> } = {},
  env: BillingEnv = process.env,
): Promise<CancelResult> {
  if (!paymentsConfigured(env) || workspaceIds.length === 0) return { ok: true, cancelled: 0 };

  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds }, stripeCustomerId: { not: null } },
    select: { id: true, stripeCustomerId: true },
  });

  const live: Array<{ workspaceId: string; subscriptionId: string }> = [];
  for (const workspace of workspaces) {
    try {
      const subscriptions = await listCustomerSubscriptions(workspace.stripeCustomerId!, env);
      for (const s of subscriptions) {
        if (isLiveSubscriptionStatus(s.status)) live.push({ workspaceId: workspace.id, subscriptionId: s.id });
      }
    } catch (error) {
      logFailure("Reading the subscriptions", workspace.id, error);
      return { ok: false, status: 502, error: CANCEL_FAILED_MESSAGE };
    }
  }
  if (live.length === 0) return { ok: true, cancelled: 0 };

  const refusal = opts.precheck ? await opts.precheck() : null;
  if (refusal) return { ok: false, status: 409, error: refusal };

  let cancelled = 0;
  for (const { workspaceId, subscriptionId } of live) {
    try {
      await cancelSubscription(subscriptionId, env);
    } catch (error) {
      // Already cancelled (by the owner, or a retry of this request) counts as done.
      const now = await retrieveSubscription(subscriptionId, env).catch(() => null);
      if (!now || isLiveSubscriptionStatus(now.status)) {
        logFailure("Cancelling a subscription", workspaceId, error);
        return { ok: false, status: 502, error: CANCEL_FAILED_MESSAGE };
      }
    }
    cancelled++;
  }
  logger.info("[billing] Subscriptions cancelled before deletion", { workspaceIds, cancelled });
  return { ok: true, cancelled };
}
