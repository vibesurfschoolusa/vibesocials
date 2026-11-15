import crypto from "crypto";

import { stripeReachable, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

import { retrieveCustomer, stripeIdempotencyKey, updateCustomerEmail } from "./stripeApi";

/**
 * R5 new-customer L4 (review): after a person's sign-in email changes (or an
 * undo puts it back), the Stripe customers they pay with get the new address,
 * so receipts and Stripe's own emails reach them. "They pay with" is read
 * from Stripe: a customer of a workspace they pay for (billingUserId: R7-
 * security L3, a payer who was demoted to member still pays) or own, whose
 * email is still their previous address (checkout creates it with the
 * payer's email). A customer someone else set up keeps its address.
 *
 * Best effort and never throws: the change itself is already made. Logs carry
 * the workspace id only, never an address (Stripe's error messages are
 * reduced to their status and code in stripeApi.ts).
 */
export async function followEmailChangeInStripe(
  change: { userId: string; from: string; to: string },
  env: BillingEnv = process.env,
): Promise<void> {
  if (!stripeReachable(env)) return;
  let workspaces: Array<{ id: string; stripeCustomerId: string | null }>;
  try {
    workspaces = await prisma.workspace.findMany({
      where: {
        stripeCustomerId: { not: null },
        OR: [{ billingUserId: change.userId }, { members: { some: { userId: change.userId, role: "owner" } } }],
      },
      select: { id: true, stripeCustomerId: true },
    });
  } catch (error) {
    logger.warn("[billing] couldn't list workspaces for a customer email change", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const from = normalizeEmail(change.from);
  // The address itself never goes into the key. The minute bucket keeps a
  // later change back to an earlier address (an undo, then a redo) from
  // meeting Stripe's stored answer for the same key and parameters.
  const toDigest = crypto.createHash("sha256").update(change.to).digest("hex").slice(0, 16);
  for (const workspace of workspaces) {
    const customerId = workspace.stripeCustomerId;
    if (!customerId) continue;
    try {
      const customer = await retrieveCustomer(customerId, env);
      if (customer.deleted || !customer.email || normalizeEmail(customer.email) !== from) continue;
      await updateCustomerEmail(
        customerId,
        change.to,
        stripeIdempotencyKey(["customer-email", customerId, toDigest], 60_000),
        env,
      );
    } catch (error) {
      logger.warn("[billing] couldn't update the Stripe customer's email", {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
