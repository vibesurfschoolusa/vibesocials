import { billingEnabled, type BillingEnv } from "@/lib/billing";
import { prisma } from "@/lib/db";

import { isLiveSubscriptionStatus } from "./subscriptionSync";

/**
 * R5-security L2 (2026-11-14): with billing on, a person may not leave a
 * workspace, or delete their account, while their card pays for the plan of a
 * workspace that carries on without them. The payer is Workspace.billingUserId,
 * recorded as they start checkout (checkout.ts). A workspace with none recorded
 * (a plan bought before the column existed; none while billing was off) is
 * skipped: the Stripe customer carries only an email and the workspace id, so
 * nothing in the app says who created it. A plan already set to end
 * (planEndsAt) is not charged again, so it holds nobody back.
 */

export function payerLeavingMessage(workspaceName: string): string {
  // No hand-over flow exists, so the way out is cancelling; another owner then starts their own plan.
  return `You pay for ${workspaceName}'s plan. Cancel it under Settings, Plan first (it stays active until the end of the period); another owner can then start their own plan.`;
}

export type PayerRefusal = { status: 409; error: string };

/** Why `userId` may not go, or null. `workspaceIds` are the workspaces that survive their going. */
export async function payerRefusal(
  input: { userId: string; workspaceIds: string[] },
  env: BillingEnv = process.env,
): Promise<PayerRefusal | null> {
  if (!billingEnabled(env) || input.workspaceIds.length === 0) return null;

  const paying = await prisma.workspace.findMany({
    where: {
      id: { in: input.workspaceIds },
      billingUserId: input.userId,
      stripeSubscriptionId: { not: null },
      planEndsAt: null,
    },
    select: { id: true, name: true, planStatus: true, billingUserId: true },
  });
  const running = paying.find((workspace) => isLiveSubscriptionStatus(workspace.planStatus));
  return running ? { status: 409, error: payerLeavingMessage(running.name) } : null;
}
