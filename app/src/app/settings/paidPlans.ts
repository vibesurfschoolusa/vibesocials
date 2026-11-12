import { stripeReachable, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { loadAccountDeletion } from "@/server/account/accountDeletion";
import { isLiveSubscriptionStatus } from "@/server/billing/subscriptionSync";

/**
 * S1: whether a delete confirmation must say that a paid plan is cancelled.
 * The delete routes cancel through cancelOnDelete.ts whenever the Stripe key
 * is set, so this asks only then; without it nothing is read and the dialogs
 * are as before. A plan counts while its subscription is live.
 */
export async function workspacesHavePaidPlan(workspaceIds: string[], env: BillingEnv = process.env): Promise<boolean> {
  if (!stripeReachable(env) || workspaceIds.length === 0) return false;
  const rows = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds }, plan: { not: null } },
    select: { planStatus: true },
  });
  return rows.some((row) => isLiveSubscriptionStatus(row.planStatus));
}

/** The same for the workspaces deleting this person's account would delete. */
export async function accountDeletionCancelsPaidPlan(userId: string, env: BillingEnv = process.env): Promise<boolean> {
  if (!stripeReachable(env)) return false;
  const { plan } = await loadAccountDeletion(userId);
  return workspacesHavePaidPlan(plan.deleteWorkspaceIds, env);
}
