import type { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import {
  LEAVE_NOT_MEMBER_MESSAGE,
  soleOwnerLeaveCase,
  soleOwnerLeaveRefusal,
} from "@/lib/leaveRefusals";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { ACTIVE_WORKSPACE_COOKIE, getWorkspaceContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { isOnlyWorkspace } from "@/server/account/deleteWorkspace";
import { payerRefusal } from "@/server/billing/payerRefusal";

import { noticeOwnersOfFormerOwner } from "../members/formerOwnerNotice";
import { signedOutResponse } from "@/lib/signedOutResponse";

/**
 * POST /api/workspaces/leave
 *
 * Deletes the CALLER's own membership row in their ACTIVE workspace; there is
 * no target id in the request body, unlike DELETE
 * /api/workspaces/members/[userId] which removes someone else. On success,
 * clears the active-workspace cookie (same options `switch` sets it with,
 * value "" + maxAge 0) so the NEXT request re-resolves via
 * `getWorkspaceContext`'s fallback (personal/oldest-owned workspace) rather
 * than pointing at a workspace the caller no longer belongs to.
 *
 * MEMBER fast path (design §1 permission matrix, Task 8): a plain
 * role-guarded `deleteMany` (`role: "member"`) — the guard in the where clause
 * means a concurrent promotion between the context read and the delete matches
 * zero rows and 404s instead of removing a freshly-promoted owner.
 *
 * OWNER path (Task D1, multi-owner): a sole owner still has no self-service
 * exit (they'd orphan the workspace -> 400, "Transfer ownership before
 * removing yourself."), but a CO-owner may now leave. That branch serializes
 * on the shared `ws-owners:<workspaceId>` advisory lock — the SAME key PATCH's
 * demote path takes, so a concurrent demote and owner-leave on one workspace
 * cannot race it to zero owners — re-reads the OTHER-owner count INSIDE the
 * lock, then deletes the caller's own row by id.
 *
 * R7-security L4: like removal (members/[userId]), leaving turns off the
 * invite links the leaver made, in the same transaction as the delete, so a
 * copy can't bring them back in as a member. Only theirs: the others' links
 * were never theirs to copy (the raw token is shown once, to its maker).
 *
 * The body carries `{ workspaceId }`, the workspace the Team card was rendered
 * for (F3): the active workspace is one cookie every tab shares, so a Leave
 * clicked in a stale tab must not leave the other workspace.
 */
/** Turns off the invite links this person made in this workspace; answers how many. */
async function revokeOwnInvites(tx: Prisma.TransactionClient, workspaceId: string, userId: string): Promise<number> {
  const { count } = await tx.workspaceInvite.updateMany({
    where: { workspaceId, createdById: userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return signedOutResponse();
  }

  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, context.workspace.id);
  if (refusal) {
    return refusal;
  }

  // Post-release review (Task D): this mutation was unguarded — per-user
  // throttle, same shared 429 envelope as posts/[postJobId]'s
  // enforceMutateRateLimit (body + Retry-After header). Placed before the
  // owner-role check below: the throttle is on the endpoint, not the outcome.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/leave",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit);
  }

  // R5-security L2: the workspace carries on without the caller, so a card of
  // theirs paying for its plan would keep paying. Asked before any write.
  const payer = await payerRefusal({ userId: context.user.id, workspaceIds: [context.workspace.id] });
  if (payer) {
    return NextResponse.json({ error: payer.error }, { status: payer.status });
  }

  if (context.role === "owner") {
    // Serialize on the shared ws-owners lock (SAME key as PATCH's demote path)
    // and re-read the OTHER-owner count INSIDE it: a co-owner may leave, a sole
    // owner may not. The caller's own row is then deleted BY ID — the fast
    // path's `role: "member"` guarded deleteMany would never match an owner row.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${context.workspace.id}`}))`;

      const otherOwnerCount = await tx.workspaceMember.count({
        where: {
          workspaceId: context.workspace.id,
          role: "owner",
          userId: { not: context.user.id },
        },
      });
      if (otherOwnerCount === 0) {
        // R34 pages L3 / R35: worded by whether anyone else is here to make an
        // owner, and (the delete route's isOnlyWorkspace) whether Delete
        // workspace would refuse; the Team card words its line with the same rule.
        const otherMemberCount = await tx.workspaceMember.count({
          where: { workspaceId: context.workspace.id, userId: { not: context.user.id } },
        });
        const memberships = await tx.workspaceMember.count({ where: { userId: context.user.id } });
        return {
          soleOwner: soleOwnerLeaveCase({ otherMembers: otherMemberCount, onlyWorkspace: isOnlyWorkspace(memberships) }),
        };
      }

      const own = await tx.workspaceMember.findFirst({
        where: { workspaceId: context.workspace.id, userId: context.user.id },
        select: { id: true },
      });
      if (!own) {
        return "not_found" as const;
      }
      await tx.workspaceMember.delete({ where: { id: own.id } });
      return { joinLinksRevoked: await revokeOwnInvites(tx, context.workspace.id, context.user.id) };
    });
    if (outcome === "not_found") {
      return NextResponse.json({ error: LEAVE_NOT_MEMBER_MESSAGE }, { status: 404 });
    }
    if (outcome.soleOwner) {
      return NextResponse.json({ error: soleOwnerLeaveRefusal(outcome.soleOwner) }, { status: 400 });
    }

    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_WORKSPACE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });

    // R5-security L1: as an owner they could copy the client links, which keep
    // working; the owners who remain are told. After the commit; never throws.
    await noticeOwnersOfFormerOwner({
      workspaceId: context.workspace.id,
      workspaceName: context.workspace.name,
      formerOwnerId: context.user.id,
      at: new Date(),
      joinLinksRevoked: outcome.joinLinksRevoked,
    });
    return NextResponse.json({ left: true }, { status: 200 });
  }

  // A member may have made invite links while an owner (since demoted).
  const count = await prisma.$transaction(async (tx) => {
    const deleted = await tx.workspaceMember.deleteMany({
      where: { workspaceId: context.workspace.id, userId: context.user.id, role: "member" },
    });
    if (deleted.count > 0) await revokeOwnInvites(tx, context.workspace.id, context.user.id);
    return deleted.count;
  });

  if (count === 0) {
    return NextResponse.json({ error: LEAVE_NOT_MEMBER_MESSAGE }, { status: 404 });
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ left: true }, { status: 200 });
}
