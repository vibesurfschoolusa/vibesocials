import { billingEnabled, stripeReachable, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

import { retrieveCustomer, StripeApiError } from "./stripeApi";
import { isLiveSubscriptionStatus } from "./subscriptionSync";

/**
 * R5-security L2 (2026-11-14): with billing on, a person may not leave a
 * workspace, or delete their account, while their card pays for the plan of a
 * workspace that carries on without them. The payer is the person whose email
 * the workspace's Stripe customer carries (checkout creates the customer with
 * the owner's email; the customer portal under Settings, Plan, Manage plan is
 * where it is handed to someone else). A plan already set to end
 * (planEndsAt) is not charged again, so it does not hold anyone back.
 */

export function payerLeavingMessage(workspaceName: string): string {
  return `You pay for the plan of "${workspaceName}", which carries on after you go. Hand over or cancel the plan under Settings, Plan first.`;
}

export const PAYER_CHECK_FAILED_MESSAGE =
  "We could not check who pays for a plan you are part of, so nothing was changed. Try again in a minute.";

export type PayerRefusal = { status: 409 | 502; error: string };

/**
 * Why the person with `email` may not go, or null. `workspaceIds` are the
 * workspaces that survive their going. Asks Stripe once per running plan
 * among them; when Stripe cannot answer, refuses (502) rather than guess.
 */
export async function payerRefusal(
  input: { email: string; workspaceIds: string[] },
  env: BillingEnv = process.env,
): Promise<PayerRefusal | null> {
  if (!billingEnabled(env) || !stripeReachable(env) || input.workspaceIds.length === 0) return null;

  const rows = await prisma.workspace.findMany({
    where: {
      id: { in: input.workspaceIds },
      stripeCustomerId: { not: null },
      stripeSubscriptionId: { not: null },
      planEndsAt: null,
    },
    select: { id: true, name: true, stripeCustomerId: true, planStatus: true },
  });
  const email = normalizeEmail(input.email);
  for (const workspace of rows) {
    if (!workspace.stripeCustomerId || !isLiveSubscriptionStatus(workspace.planStatus)) continue;
    let customer: Awaited<ReturnType<typeof retrieveCustomer>>;
    try {
      customer = await retrieveCustomer(workspace.stripeCustomerId, env);
    } catch (error) {
      logger.error("[billing] Could not read the plan's Stripe customer before someone left", {
        workspaceId: workspace.id,
        status: error instanceof StripeApiError ? error.status : null,
        code: error instanceof StripeApiError ? error.code : null,
      });
      return { status: 502, error: PAYER_CHECK_FAILED_MESSAGE };
    }
    if (!customer.deleted && customer.email && normalizeEmail(customer.email) === email) {
      return { status: 409, error: payerLeavingMessage(workspace.name) };
    }
  }
  return null;
}
