import type { PrismaClient } from "@prisma/client";

import { billingEnabled, trialDays, type BillingEnv } from "@/lib/billing";
import { isOperatorUser } from "@/lib/operator";

/**
 * What a new workspace is created with (21a, fix round 1). The only writer of
 * a trial: billing off writes nothing, so such a workspace has no trial and
 * stays exempt (planState), whenever billing is switched on.
 *
 * One person gets one trial window. The first workspace they create with
 * billing on starts it (User.trialStartedAt = now); every later one, by
 * registration or "new workspace", ends its trial at trialStartedAt + trial
 * days, even when that is already past. Deleting a workspace does not reset it.
 * A workspace an operator creates is exempt: the operator bills it by hand.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialClient = {
  user: Pick<PrismaClient["user"], "findUnique" | "updateMany">;
};

export async function newWorkspaceBillingData(
  tx: TrialClient,
  userId: string,
  now: Date,
  env: BillingEnv = process.env,
): Promise<{ billingExempt?: boolean; trialEndsAt?: Date }> {
  if (!billingEnabled(env)) return {};

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true, trialStartedAt: true },
  });
  if (!user) throw new Error(`newWorkspaceBillingData: no such user "${userId}"`);
  if (isOperatorUser(user, env)) return { billingExempt: true };

  let startedAt = user.trialStartedAt;
  if (!startedAt) {
    // Conditional, so two creations at once cannot both start a window.
    const started = await tx.user.updateMany({
      where: { id: userId, trialStartedAt: null },
      data: { trialStartedAt: now },
    });
    if (started.count === 1) {
      startedAt = now;
    } else {
      const again = await tx.user.findUnique({ where: { id: userId }, select: { trialStartedAt: true } });
      startedAt = again?.trialStartedAt ?? now;
    }
  }
  return { billingExempt: false, trialEndsAt: new Date(startedAt.getTime() + trialDays(env) * DAY_MS) };
}
