import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { buildAccountDeletedEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { accountDeletionRefusal, loadAccountDeletion } from "@/server/account/accountDeletion";
import {
  DeletionRefusedError,
  FINISH_FAILED_MESSAGE,
  POST_PUBLISHING_MESSAGE,
  deleteWorkspaceFiles,
  deleteWorkspaceRows,
  isPostPublishing,
} from "@/server/account/deleteWorkspace";
import { pickHeir, type AccountDeletionPlan } from "@/server/account/deletionPlan";

// Same bound as DELETE /api/workspaces/active: about 10 s per 100 media items.
export const maxDuration = 60;

const FILES_FAILED_MESSAGE = "Could not delete all of your workspaces' files. Try again.";
const PLAN_CHANGED_MESSAGE =
  "Your workspaces changed while this was running. Nothing was deleted from your account. Try again.";

/**
 * DELETE /api/auth/account { password } or, for a Google-only user, { confirmEmail }
 *
 * Deletes the signed-in user. Everything acted on comes from the user's own
 * memberships and rows in the database, never from the body, so the only
 * workspaces deleted are ones this user owns with nobody else in them.
 *
 * Order: plan, refuse if blocked or publishing, delete stored files (a
 * failure here changes no row), then one transaction: re-check the plan
 * (the file cleanup can take tens of seconds), reassign the user's rows in
 * surviving workspaces, delete the planned workspaces, delete the user last.
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

  const { plan } = await loadAccountDeletion(user.id);
  const refusal = await accountDeletionRefusal(plan);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 409 });
  }

  if (plan.deleteWorkspaceIds.length > 0) {
    try {
      await deleteWorkspaceFiles(plan.deleteWorkspaceIds);
    } catch (error) {
      logger.error("[DELETE /api/auth/account] File cleanup failed", { userId: user.id, error });
      return NextResponse.json({ error: FILES_FAILED_MESSAGE }, { status: 500 });
    }
  }

  try {
    await deleteInTransaction(user.id, plan);
  } catch (error) {
    if (error instanceof DeletionRefusedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error("[DELETE /api/auth/account] Database step failed", { userId: user.id, error });
    const message =
      plan.deleteWorkspaceIds.length > 0 ? FINISH_FAILED_MESSAGE : "Could not delete your account. Try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Best-effort: deliverAccountEmail logs and returns false on any failure.
  await deliverAccountEmail(user.email, buildAccountDeletedEmail());

  return NextResponse.json({ deleted: true }, { status: 200 });
}

async function deleteInTransaction(userId: string, plan: AccountDeletionPlan): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Re-check every reassignment under the same ws-owners lock the leave
      // and demote paths take, so the heir cannot leave or be demoted between
      // this check and the commit. Locks are taken in id order so two account
      // deletions cannot deadlock on each other's workspaces.
      const reassign = [...plan.reassign].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));
      for (const { workspaceId, toUserId } of reassign) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${workspaceId}`}))`;
        const others = await tx.workspaceMember.findMany({
          where: { workspaceId, userId: { not: userId } },
          select: { userId: true, role: true, createdAt: true },
        });
        if (pickHeir(others) !== toUserId) {
          throw new DeletionRefusedError(PLAN_CHANGED_MESSAGE);
        }
      }

      if (plan.deleteWorkspaceIds.length > 0) {
        const joined = await tx.workspaceMember.count({
          where: { workspaceId: { in: plan.deleteWorkspaceIds }, userId: { not: userId } },
        });
        if (joined > 0) {
          throw new DeletionRefusedError(PLAN_CHANGED_MESSAGE);
        }
        if (await isPostPublishing(plan.deleteWorkspaceIds, tx)) {
          throw new DeletionRefusedError(POST_PUBLISHING_MESSAGE);
        }
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
    },
    { timeout: 15_000 },
  );
}
