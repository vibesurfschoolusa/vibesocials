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

/**
 * No hand-over flow exists, so the way out is cancelling; another owner then
 * starts their own plan. An owner cancels under Settings, Plan; a payer who is
 * no longer an owner has only "Manage your payment" (review).
 */
export function payerLeavingMessage(workspaceName: string, isOwner = true): string {
  const where = isOwner ? "under Settings, Plan" : "with Manage your payment in Settings";
  return `You pay for ${workspaceName}'s plan. Cancel it ${where} first (it stays active until the end of the period); another owner can then start their own plan.`;
}

/**
 * Whether `userId` is the recorded payer of a plan that is still running, with
 * a Stripe customer to manage (reviews of L2): such a person may open the
 * customer portal even when no longer an owner, to cancel or change the card.
 * Once the subscription has ended there is nothing left to pay, so the payer's
 * Settings entry and portal access go with it (billingUserId stays, unread).
 */
export async function isWorkspacePayer(workspaceId: string, userId: string): Promise<boolean> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingUserId: true, stripeCustomerId: true, stripeSubscriptionId: true, planStatus: true },
  });
  return (
    row !== null &&
    row.billingUserId === userId &&
    Boolean(row.stripeCustomerId) &&
    Boolean(row.stripeSubscriptionId) &&
    isLiveSubscriptionStatus(row.planStatus)
  );
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
    select: {
      id: true,
      name: true,
      planStatus: true,
      billingUserId: true,
      members: { where: { userId: input.userId }, select: { role: true } },
    },
  });
  const running = paying.find((workspace) => isLiveSubscriptionStatus(workspace.planStatus));
  if (!running) return null;
  return { status: 409, error: payerLeavingMessage(running.name, running.members[0]?.role === "owner") };
}
