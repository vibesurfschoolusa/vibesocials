import { NextResponse } from "next/server";

import { inviteLinkWorks } from "@/app/api/invites/[token]/inviteMaker";
import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { generateInviteToken, INVITE_TTL_MS } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal, sentWorkspaceId } from "@/lib/workspaceChanged";

/**
 * GET /api/workspaces/invites
 *
 * Returns the active (non-revoked) invite's metadata, if any. `url` is
 * ALWAYS null here: only the SHA-256 hash of the raw token is ever
 * persisted (see src/lib/inviteToken.ts), so once the create-time response
 * has been shown, the link is unrecoverable — `url: null` signals "an
 * active invite exists but its link can't be re-shown." Task 7's UI offers
 * Revoke + Create-new instead of a re-show affordance.
 *
 * R10-client-journey L3: only a link that still works (inviteLinkWorks: not
 * expired, its maker still an owner); otherwise null, so the card offers Create.
 */
export async function GET(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  // R32: the page's workspace, so Team never shows another one's invite link.
  const workspaceRefusal = renderedWorkspaceRefusal(sentWorkspaceId(request), contextOrError.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;
  const context = contextOrError;

  const invite = await prisma.workspaceInvite.findFirst({
    where: { workspaceId: context.workspace.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!invite || (await inviteLinkWorks(prisma, invite)) !== true) {
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
 * invite simultaneously "active", nor two active invites at once.
 *
 * CONCURRENCY (review fix round 1, Important 2): revoke-then-create alone
 * is not atomic ACROSS transactions — two concurrent POSTs could each
 * revoke the (same) prior invites and then BOTH create, leaving two active
 * invites. The transaction therefore first takes a Postgres
 * TRANSACTION-SCOPED advisory lock keyed per workspace
 * (`pg_advisory_xact_lock` — auto-released at commit/rollback), the same
 * pattern `ensurePersonalWorkspace` in src/lib/workspace.ts established:
 * the second POST blocks on the lock until the first commits, then its
 * revoke pass sees (and revokes) the first's fresh invite before creating
 * its own — at most one active invite survives any interleaving.
 *
 * Returns the raw token embedded in the join URL; this is the ONLY time the
 * raw token is ever available (only its hash is persisted).
 *
 * POST and DELETE carry `{ workspaceId }`, the workspace the Team card was
 * rendered for (F3): the active workspace is one cookie for every tab, so a
 * stale tab must not invite people into, or revoke the link of, another one.
 */
export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;
  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, context.workspace.id);
  if (refusal) {
    return refusal;
  }

  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  let invite;
  try {
    invite = await prisma.$transaction(async (tx) => {
      // Serialize invite creation per workspace (see doc comment above).
      // hashtext() folds the string key into the advisory-lock integer
      // space; xact-scoped, so it releases when this transaction ends.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-invite:${context.workspace.id}`}))`;

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
    return NextResponse.json({ error: "Couldn't create an invite link. Try again in a minute." }, { status: 500 });
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
export async function DELETE(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;
  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, context.workspace.id);
  if (refusal) {
    return refusal;
  }

  await prisma.workspaceInvite.updateMany({
    where: { workspaceId: context.workspace.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
