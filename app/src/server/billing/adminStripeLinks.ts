import { prisma } from "@/lib/db";

/**
 * Whether a workspace is linked to Stripe, for the operator's admin page
 * (21b). Yes or no only: the ids never leave the server, so the page cannot
 * show or leak them.
 */
export async function stripeLinkFlags(workspaceId: string): Promise<{ hasCustomer: boolean; hasSubscription: boolean }> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true },
  });
  return { hasCustomer: Boolean(row?.stripeCustomerId), hasSubscription: Boolean(row?.stripeSubscriptionId) };
}
