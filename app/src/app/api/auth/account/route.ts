import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { buildAccountDeletedEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { accountDeletionRefusal, blockedMessage, loadAccountDeletion } from "@/server/account/accountDeletion";
import {
  DeletionRefusedError,
  POST_PUBLISHING_MESSAGE,
  deleteQueuedFiles,
  deleteWorkspaceRows,
  isPostPublishing,
  lockWorkspaceOwners,
  queueWorkspaceFiles,
  type QueuedFile,
} from "@/server/account/deleteWorkspace";
import { samePlan, type AccountDeletionPlan } from "@/server/account/deletionPlan";
import {
  CANCELLED_ACCOUNT_KEPT_MESSAGE,
  CANCELLED_ACCOUNT_KEPT_PREFIX,
  cancelSubscriptionsBeforeDelete,
} from "@/server/billing/cancelOnDelete";

// Same bound as DELETE /api/workspaces/active: a 15 s transaction, then at
// most 20 s of file deletion.
export const maxDuration = 60;

const ACCOUNT_DELETE_FAILED_MESSAGE = "Could not delete your account. Nothing was changed. Try again.";
const PLAN_CHANGED_MESSAGE =
  "Your workspaces changed while this was running. Nothing was deleted from your account. Try again.";

/**
 * DELETE /api/auth/account { password } or, for a Google-only user, { confirmEmail }
 *
 * Deletes the signed-in user. Everything acted on comes from the user's own
 * memberships and rows in the database, never from the body, so the only
 * workspaces deleted are ones this user owns with nobody else in them.
 *
 * Order: read the plan, refuse if blocked, then one transaction that locks,
 * plans again from fresh rows (refusing on any difference), queues the stored
 * files that must go, reassigns the user's rows in surviving workspaces,
 * deletes the planned workspaces and deletes the user last. Only after the
 * commit are the files deleted.
 */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fails closed: this guards a password check.
  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "auth/delete-account",
    limit: 5,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  if (user.passwordHash) {
    if (typeof body.password !== "string" || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return NextResponse.json({ error: "Your password is not correct." }, { status: 400 });
    }
  } else if (
    typeof body.confirmEmail !== "string" ||
    normalizeEmail(body.confirmEmail) !== normalizeEmail(user.email)
  ) {
    return NextResponse.json(
      { error: "That email does not match the one on this account." },
      { status: 400 },
    );
  }

  // Read-only: what the transaction below must confirm under its locks.
  const { plan } = await loadAccountDeletion(user.id);
  if (plan.blocked.length > 0) {
    return NextResponse.json({ error: blockedMessage(plan.blocked) }, { status: 409 });
  }

  // 21b: cancel the deleted workspaces' plans at Stripe first; a no-op with payments not configured.
  const cancel = await cancelSubscriptionsBeforeDelete(plan.deleteWorkspaceIds, {
    precheck: () => accountDeletionRefusal(plan),
  });
  if (!cancel.ok) {
    return NextResponse.json({ error: cancel.error }, { status: cancel.status });
  }
  const cancelled = cancel.cancelled > 0;

  let queued: QueuedFile[];
  try {
    queued = await deleteInTransaction(user.id, plan);
  } catch (error) {
    if (error instanceof DeletionRefusedError) {
      const message = cancelled ? `${CANCELLED_ACCOUNT_KEPT_PREFIX} ${error.message}` : error.message;
      return NextResponse.json({ error: message }, { status: 409 });
    }
    logger.error("[DELETE /api/auth/account] Transaction failed", { userId: user.id, error });
    return NextResponse.json(
      { error: cancelled ? CANCELLED_ACCOUNT_KEPT_MESSAGE : ACCOUNT_DELETE_FAILED_MESSAGE },
      { status: 500 },
    );
  }

  // Never throws; what it cannot finish stays queued for the hourly drain.
  await deleteQueuedFiles(queued);

  // Best-effort: deliverAccountEmail logs and returns false on any failure.
  await deliverAccountEmail(user.email, buildAccountDeletedEmail());

  return NextResponse.json({ deleted: true }, { status: 200 });
}

/**
 * Everything that decides and changes data, in one transaction: lock, plan
 * again from fresh rows, queue the stored files, reassign, delete. Any failed
 * check throws DeletionRefusedError and the transaction rolls back.
 */
async function deleteInTransaction(userId: string, plan: AccountDeletionPlan): Promise<QueuedFile[]> {
  return prisma.$transaction(
    async (tx) => {
      // The same ws-owners lock the leave and demote paths take, on the union
      // of the workspaces in the first plan and in a fresh read, in id order
      // so two deletions cannot deadlock on each other's workspaces.
      const seen = await loadAccountDeletion(userId, tx);
      const lockIds = [
        ...new Set([
          ...plan.deleteWorkspaceIds,
          ...plan.reassign.map((r) => r.workspaceId),
          ...plan.blocked.map((b) => b.workspaceId),
          ...seen.workspaces.map((w) => w.workspaceId),
        ]),
      ].sort();
      for (const workspaceId of lockIds) {
        await lockWorkspaceOwners(tx, workspaceId);
      }

      // Under the locks, plan again from fresh rows; anything different (a
      // workspace now blocked or newly joined, another heir, another delete
      // list) refuses. Comparing whole plans, not just heir ids, catches an
      // heir who stepped down to member and is still the member fallback.
      // A workspace joined after the read above is not locked, but every
      // workspace lands in one of the plan's lists, so it changes the plan.
      const fresh = await loadAccountDeletion(userId, tx);
      if (!samePlan(plan, fresh.plan)) {
        throw new DeletionRefusedError(PLAN_CHANGED_MESSAGE);
      }

      let queued: QueuedFile[] = [];
      if (plan.deleteWorkspaceIds.length > 0) {
        if (await isPostPublishing(plan.deleteWorkspaceIds, tx)) {
          throw new DeletionRefusedError(POST_PUBLISHING_MESSAGE);
        }
        queued = await queueWorkspaceFiles(tx, plan.deleteWorkspaceIds);
      }

      // These four tables cascade from User: without this the surviving
      // workspaces would lose this user's connections, media and posts.
      for (const { workspaceId, toUserId } of plan.reassign) {
        const args = { where: { workspaceId, userId }, data: { userId: toUserId } };
        await tx.socialConnection.updateMany(args);
        await tx.mediaItem.updateMany(args);
        await tx.postJob.updateMany(args);
        await tx.postMetric.updateMany(args);
      }

      await deleteWorkspaceRows(tx, plan.deleteWorkspaceIds);

      // Keyed by userId with no foreign key, so nothing cascades them. Both
      // hold sealed OAuth secrets of an unfinished connect.
      await tx.pendingConnection.deleteMany({ where: { userId } });
      await tx.oAuthHandshake.deleteMany({ where: { userId } });

      await tx.user.delete({ where: { id: userId } });
      return queued;
    },
    { timeout: 15_000 },
  );
}
