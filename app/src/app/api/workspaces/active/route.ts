import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  ACTIVE_WORKSPACE_COOKIE,
  provisionPersonalWorkspace,
  requireOwnerContext,
} from "@/lib/workspace";
import {
  DeletionRefusedError,
  WORKSPACE_DELETE_FAILED_MESSAGE,
  deleteQueuedFiles,
  deleteWorkspaceRows,
  lockWorkspaceOwners,
  queueWorkspaceFiles,
  workspaceDeletionRefusal,
  type QueuedFile,
} from "@/server/account/deleteWorkspace";

// The transaction is capped at 15 s and the file deletion after it at 20 s
// (AFTER_COMMIT_BUDGET_MS), so this leaves room for both.
export const maxDuration = 60;

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 60;

/**
 * PATCH /api/workspaces/active { name }
 *
 * Owner-only rename of the caller's active workspace (design doc §4). Footer
 * fields (companyWebsite/defaultHashtags) stay on `POST /api/settings` — not
 * handled here.
 */
export async function PATCH(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  if (typeof body.name !== "string") {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  const trimmed = body.name.trim();
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const updated = await prisma.workspace.update({
    where: { id: context.workspace.id },
    data: { name: trimmed },
    select: { id: true, name: true },
  });

  return NextResponse.json({ id: updated.id, name: updated.name }, { status: 200 });
}

/**
 * DELETE /api/workspaces/active { confirmName }
 *
 * Owner-only deletion of the caller's ACTIVE workspace; the body names no
 * workspace, so a caller can only ever delete the one they are an owner of.
 *
 * One transaction decides and changes everything: under the ws-owners lock it
 * refuses while another owner exists, a post is publishing, or it is the
 * caller's last workspace; otherwise it queues the stored files that must go,
 * deletes the workspace (everything in it cascades) and gives any member left
 * with no workspace a personal one. Only after the commit are the files
 * deleted; what is not done within AFTER_COMMIT_BUDGET_MS stays queued for the
 * hourly drain, and the request succeeds either way.
 */
export async function DELETE(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;
  const workspaceId = context.workspace.id;

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/delete",
    limit: 10,
    windowMs: 60 * 60 * 1000,
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
  if (body.confirmName !== context.workspace.name) {
    return NextResponse.json(
      { error: "Type the workspace name exactly as it is shown to confirm." },
      { status: 400 },
    );
  }

  let queued: QueuedFile[];
  try {
    queued = await deleteInTransaction(workspaceId, context.user.id);
  } catch (error) {
    if (error instanceof DeletionRefusedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error("[DELETE /api/workspaces/active] Transaction failed", { workspaceId, error });
    return NextResponse.json({ error: WORKSPACE_DELETE_FAILED_MESSAGE }, { status: 500 });
  }

  // Never throws; what it cannot finish stays queued.
  await deleteQueuedFiles(queued);

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}

async function deleteInTransaction(workspaceId: string, userId: string): Promise<QueuedFile[]> {
  return prisma.$transaction(
    async (tx) => {
      await lockWorkspaceOwners(tx, workspaceId);
      const refusal = await workspaceDeletionRefusal(workspaceId, userId, tx);
      if (refusal) {
        throw new DeletionRefusedError(refusal);
      }

      const others = await tx.workspaceMember.findMany({
        where: { workspaceId, userId: { not: userId } },
        select: { user: { select: { id: true, name: true, email: true } } },
      });

      const queued = await queueWorkspaceFiles(tx, [workspaceId]);
      await deleteWorkspaceRows(tx, [workspaceId]);

      // getWorkspaceContext would also self-heal a member with no workspace
      // on their next request; doing it here means they never hit that path.
      // Same per-user advisory lock as that self-heal, so the two cannot both
      // provision one. Locks go in user-id order, so two workspace deletions
      // that share members cannot deadlock on each other's ws-provision locks.
      const byUserId = [...others].sort((a, b) => (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0));
      for (const { user } of byUserId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-provision:${user.id}`}))`;
        const remaining = await tx.workspaceMember.count({ where: { userId: user.id } });
        if (remaining === 0) {
          await provisionPersonalWorkspace(tx, user);
        }
      }
      return queued;
    },
    { timeout: 15_000 },
  );
}

