import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { generateInviteToken, INVITE_TTL_MS } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { getWorkspaceContext, WorkspaceForbiddenError, type WorkspaceContext } from "@/lib/workspace";

/**
 * Resolves the caller's owner-role workspace context, or an error response
 * to return as-is (mirrors the identical helper in workspaces/active/route.ts
 * — small per-file duplication, per the Task 3 brief).
 */
async function requireOwnerContext(): Promise<WorkspaceContext | NextResponse> {
  try {
    const context = await getWorkspaceContext({ requireRole: "owner" });
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return context;
  } catch (error) {
    if (error instanceof WorkspaceForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

/**
 * GET /api/workspaces/invites
 *
 * Returns the active (non-revoked) invite's metadata, if any. `url` is
 * ALWAYS null here: only the SHA-256 hash of the raw token is ever
 * persisted (see src/lib/inviteToken.ts), so once the create-time response
 * has been shown, the link is unrecoverable — `url: null` signals "an
 * active invite exists but its link can't be re-shown." Task 7's UI offers
 * Revoke + Create-new instead of a re-show affordance.
 */
export async function GET() {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  const invite = await prisma.workspaceInvite.findFirst({
    where: { workspaceId: context.workspace.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!invite) {
    return NextResponse.json({ invite: null }, { status: 200 });
  }

  return NextResponse.json(
    {
      invite: {
        url: null,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
    },
    { status: 200 },
  );
}

/**
 * POST /api/workspaces/invites
 *
 * Single-active-invite policy (design doc §1/§4): revokes every currently
 * active invite for this workspace, then creates a new one — both inside one
 * transaction, so a reader never observes a workspace with zero AND the old
 * invite simultaneously "active", nor two active invites at once. Returns
 * the raw token embedded in the join URL; this is the ONLY time the raw
 * token is ever available (only its hash is persisted).
 */
export async function POST() {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  let invite;
  try {
    invite = await prisma.$transaction(async (tx) => {
      await tx.workspaceInvite.updateMany({
        where: { workspaceId: context.workspace.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return tx.workspaceInvite.create({
        data: {
          workspaceId: context.workspace.id,
          tokenHash: hash,
          createdById: context.user.id,
          expiresAt,
        },
      });
    });
  } catch (error) {
    logger.error("[POST /api/workspaces/invites] Unexpected error", {
      error,
      workspaceId: context.workspace.id,
      userId: context.user.id,
    });
    return NextResponse.json({ error: "Failed to create invite" }, { status: 500 });
  }

  const url = `${process.env.NEXTAUTH_URL ?? ""}/join/${raw}`;

  return NextResponse.json(
    { url, expiresAt: invite.expiresAt.toISOString() },
    { status: 200 },
  );
}

/**
 * DELETE /api/workspaces/invites
 *
 * Revokes the workspace's active invite, if any. Idempotent: revoking when
 * there is nothing active still returns 200 { ok: true } (the resulting
 * state — no active invite — is identical either way).
 */
export async function DELETE() {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  await prisma.workspaceInvite.updateMany({
    where: { workspaceId: context.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
