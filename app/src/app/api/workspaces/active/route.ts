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
  FINISH_FAILED_MESSAGE,
  POST_PUBLISHING_MESSAGE,
  WORKSPACE_FILES_FAILED_MESSAGE,
  deleteWorkspaceFiles,
  deleteWorkspaceRows,
  isPostPublishing,
  workspaceDeletionRefusal,
} from "@/server/account/deleteWorkspace";

// The file cleanup is bounded at about 10 s per 100 media items (see
// BLOB_DELETE_BATCH_SIZE), so a 300-item workspace fits well inside this.
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
 * Refused while another owner exists, a post is publishing, or it is the
 * caller's last workspace. Stored files go first: if that fails, no row has
 * changed. Then one transaction checks again that no post is publishing (the
 * file cleanup can take tens of seconds), deletes the workspace (everything
 * in it cascades) and gives any member left with no workspace a personal one.
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

  const refusal = await workspaceDeletionRefusal(workspaceId, context.user.id);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 409 });
  }

  try {
    await deleteWorkspaceFiles([workspaceId]);
  } catch (error) {
    logger.error("[DELETE /api/workspaces/active] File cleanup failed", { workspaceId, error });
    return NextResponse.json({ error: WORKSPACE_FILES_FAILED_MESSAGE }, { status: 500 });
  }

  try {
    await deleteInTransaction(workspaceId, context.user.id);
  } catch (error) {
    if (error instanceof DeletionRefusedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error("[DELETE /api/workspaces/active] Database step failed after the files", {
      workspaceId,
      error,
    });
    return NextResponse.json({ error: FINISH_FAILED_MESSAGE }, { status: 500 });
  }

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

async function deleteInTransaction(workspaceId: string, userId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const others = await tx.workspaceMember.findMany({
        where: { workspaceId, userId: { not: userId } },
        select: { user: { select: { id: true, name: true, email: true } } },
      });

      if (await isPostPublishing([workspaceId], tx)) {
        throw new DeletionRefusedError(POST_PUBLISHING_MESSAGE);
      }
      await deleteWorkspaceRows(tx, [workspaceId]);

      // getWorkspaceContext would also self-heal a member with no workspace
      // on their next request; doing it here means they never hit that path.
      // Same per-user advisory lock as that self-heal, so the two cannot both
      // provision one.
      for (const { user } of others) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-provision:${user.id}`}))`;
        const remaining = await tx.workspaceMember.count({ where: { userId: user.id } });
        if (remaining === 0) {
          await provisionPersonalWorkspace(tx, user);
        }
      }
    },
    { timeout: 15_000 },
  );
}
