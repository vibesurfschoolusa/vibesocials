import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { buildAccountDeletedEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { accountDeleteLockedSentence } from "@/lib/displayDate";
import { normalizeEmail } from "@/lib/email";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { personLabel } from "@/lib/usageLimits";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { limitUncheckedResponse } from "@/lib/limitUnchecked";
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
import { accountUndoWindowUntil } from "@/server/auth/undoWindow";
import { payerRefusal } from "@/server/billing/payerRefusal";
import { noticeOwnersOfFormerOwner } from "@/app/api/workspaces/members/formerOwnerNotice";
import { copyUsageBeforeDeletion } from "@/server/usage/usageLog";
import { signedOutResponse } from "@/lib/signedOutResponse";

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
    return signedOutResponse();
  }

  // Fails closed: this guards a password check.
  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "auth/delete-account",
    limit: 5,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (rateLimit.unavailable) return limitUncheckedResponse();
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit);
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

  // R6 review: while the previous address can undo an email change, deleting
  // the account would leave the undo nothing to put back (a hijacker who
  // changed the email could then erase the account for good). Asked before
  // anything else, Stripe included. `until` lets the dialog write the date in
  // the viewer's time zone.
  const lockedUntil = await accountUndoWindowUntil(prisma, user.id, new Date());
  if (lockedUntil) {
    return NextResponse.json(
      { error: accountDeleteLockedSentence(lockedUntil), until: lockedUntil.toISOString() },
      { status: 409 },
    );
  }

  // Read-only: what the transaction below must confirm under its locks.
  const { plan, workspaces } = await loadAccountDeletion(user.id);
  if (plan.blocked.length > 0) {
    return NextResponse.json({ error: blockedMessage(plan.blocked) }, { status: 409 });
  }

  // R5-security L2: a card of theirs paying for a workspace that survives
  // would keep paying after the account is gone. Asked before any cancel.
  const payer = await payerRefusal({ userId: user.id, workspaceIds: plan.reassign.map((r) => r.workspaceId) });
  if (payer) {
    return NextResponse.json({ error: payer.error }, { status: payer.status });
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
  let joinLinksRevoked: ReadonlyMap<string, number>;
  try {
    ({ queued, joinLinksRevoked } = await deleteInTransaction(user.id, plan));
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

  // R5-security L1 (review): in each co-owned workspace that carries on, the
  // owners left are told the deleted owner had its client links. After the
  // commit; never throws. The name is passed: the person's row is gone.
  const survives = new Set(plan.reassign.map((r) => r.workspaceId));
  // The readers are the owners left: the one person label (R15-new-customer L3).
  const formerOwnerName = personLabel(user, true);
  const at = new Date();
  for (const workspace of workspaces) {
    if (workspace.role !== "owner" || !survives.has(workspace.workspaceId)) continue;
    await noticeOwnersOfFormerOwner({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name,
      formerOwnerId: user.id,
      formerOwnerName,
      at,
      // R11-client-journey L4: the email says how many of their invite links went with the account.
      joinLinksRevoked: joinLinksRevoked.get(workspace.workspaceId) ?? 0,
      deletedAccount: true,
    });
  }

  // Best-effort: deliverAccountEmail logs and returns false on any failure.
  await deliverAccountEmail(user.email, buildAccountDeletedEmail());

  return NextResponse.json({ deleted: true }, { status: 200 });
}

/**
 * Everything that decides and changes data, in one transaction: lock, plan
 * again from fresh rows, queue the stored files, reassign, delete. Any failed
 * check throws DeletionRefusedError and the transaction rolls back.
 */
async function deleteInTransaction(
  userId: string,
  plan: AccountDeletionPlan,
): Promise<{ queued: QueuedFile[]; joinLinksRevoked: Map<string, number> }> {
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

      // R5-security M1: what still counts toward the limits outlives the rows.
      await copyUsageBeforeDeletion(tx, { workspaceIds: plan.deleteWorkspaceIds, userId, now: new Date() });
      await deleteWorkspaceRows(tx, plan.deleteWorkspaceIds);

      // Keyed by userId with no foreign key, so nothing cascades them. Both
      // hold sealed OAuth secrets of an unfinished connect.
      await tx.pendingConnection.deleteMany({ where: { userId } });
      await tx.oAuthHandshake.deleteMany({ where: { userId } });
      // R10-client-journey L3: also keyed by a plain id. The invite links this
      // person made in the workspaces that survive stop working with them.
      // R11-client-journey L4: counted per surviving workspace for the owners'
      // email; the last call turns off any made anywhere else.
      const joinLinksRevoked = new Map<string, number>();
      const revokedAt = new Date();
      for (const { workspaceId } of plan.reassign) {
        const { count } = await tx.workspaceInvite.updateMany({
          where: { workspaceId, createdById: userId, revokedAt: null },
          data: { revokedAt },
        });
        joinLinksRevoked.set(workspaceId, count);
      }
      await tx.workspaceInvite.updateMany({
        where: { createdById: userId, revokedAt: null },
        data: { revokedAt },
      });

      await tx.user.delete({ where: { id: userId } });
      return { queued, joinLinksRevoked };
    },
    { timeout: 15_000 },
  );
}
