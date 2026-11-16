import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { payerRefusal } from "@/server/billing/payerRefusal";

import { noticeOwnersOfFormerOwner } from "../formerOwnerNotice";

/**
 * R25 new-customer L2: the target is no longer in the workspace (removed by
 * another owner, left, or changed meanwhile). `gone` lets the Team card drop
 * the row; the 404 still says nothing about other workspaces.
 */
function memberGone() {
  return NextResponse.json(
    {
      error: "This person is no longer in the workspace. Reload the page to see the current members.",
      gone: true,
    },
    { status: 404 },
  );
}

/**
 * KK3 follow-up: a promote or demote matched nothing, but the person is still
 * in the workspace: another owner changed their role meanwhile. Not "gone", so
 * the Team card keeps the row.
 */
function roleChanged() {
  return NextResponse.json(
    { error: "Their role changed in the meantime. Reload the page to see the current members.", roleChanged: true },
    { status: 409 },
  );
}

async function stillMember(
  db: Pick<typeof prisma, "workspaceMember">,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const membership = await db.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { role: true } });
  return membership !== null;
}

interface MemberRouteContext {
  params: Promise<{ userId: string }>;
}

/**
 * DELETE /api/workspaces/members/[userId]
 *
 * Owner-only member removal (design doc §4). v1 has no ownership-transfer
 * flow (out of scope — design doc §10), so the owner can never remove
 * themselves; they'd be left with an ownerless workspace. This is checked
 * BEFORE the not-a-member lookup since the owner is always a member of their
 * own active workspace, so a self-removal attempt would otherwise reach the
 * (misleading) 404 branch instead of the correct 400.
 *
 * Owner-role targets remain non-removable through THIS route (review fix
 * round 1, Minor 2); one answers the 409 roleChanged (R26). Multi-owner now exists (Task D1), so removing a co-owner
 * is the explicit demotion flow this guard always anticipated —
 * `PATCH /api/workspaces/members/[userId] { role: "member" }`, not a member
 * delete. The role is still read for the 400-vs-404 disambiguation, and the
 * guard is REPEATED in the delete's where clause (`role: { not: "owner" }`,
 * conditional-mutation pattern) so a promotion racing between the read and the
 * delete still can't remove an owner — the delete then matches nothing and
 * answers 409 roleChanged (404 gone if they left). To remove a co-owner: demote them via PATCH first, then DELETE.
 *
 * Removal also REVOKES the workspace's active invite links (2026-11-01 audit):
 * the join link is 7-day / unlimited-use, so a removed member holding it could
 * otherwise rejoin immediately. The delete and the revoke run in one
 * transaction (a refused or no-op removal revokes nothing); the response is
 * `{ ok: true, invitesRevoked }` so the owner's UI can clear the link it is
 * showing. "Active" means `revokedAt: null`, exactly as the invites route
 * defines it.
 *
 * DELETE and PATCH carry `{ workspaceId }`, the workspace the Team card was
 * rendered for (F3): the active workspace is one cookie every tab shares and a
 * person can be in both workspaces, so a stale tab must not remove or change
 * them in the other one.
 */
export async function DELETE(request: Request, { params }: MemberRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;
  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, context.workspace.id);
  if (refusal) {
    return refusal;
  }

  const { userId: targetUserId } = await params;

  if (targetUserId === context.user.id) {
    return NextResponse.json(
      { error: "Transfer ownership before removing yourself." },
      { status: 400 },
    );
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: context.workspace.id, userId: targetUserId },
    select: { role: true },
  });

  if (!membership) {
    return memberGone();
  }

  // R26 new-customer L2: the Team card offers Remove only on a member row, so
  // an owner here was made owner by a co-owner meanwhile. The role change's
  // answer lets the card close the dialog and keep the row.
  if (membership.role === "owner") {
    return roleChanged();
  }

  // R6-security L1: a co-owner could demote the payer and then remove them,
  // and their card would keep paying for a workspace they are no longer in.
  const payer = await payerRefusal({ userId: targetUserId, workspaceIds: [context.workspace.id], removedByOther: true });
  if (payer) {
    return NextResponse.json({ error: payer.error }, { status: payer.status });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const { count } = await tx.workspaceMember.deleteMany({
      where: { workspaceId: context.workspace.id, userId: targetUserId, role: { not: "owner" } },
    });
    if (count === 0) {
      return null;
    }

    const revoked = await tx.workspaceInvite.updateMany({
      where: { workspaceId: context.workspace.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { invitesRevoked: revoked.count };
  });

  // The delete matched nothing: gone, or (the role change's rule) made owner
  // meanwhile and still here.
  if (!outcome) {
    return (await stillMember(prisma, context.workspace.id, targetUserId)) ? roleChanged() : memberGone();
  }

  return NextResponse.json({ ok: true, invitesRevoked: outcome.invitesRevoked }, { status: 200 });
}

/**
 * PATCH /api/workspaces/members/[userId]  { role: "owner" | "member" }
 *
 * Owner-only co-owner management (Task D1, multi-owner). Promotes a member to
 * owner or demotes an owner to member; returns 200 `{ ok: true, role }`.
 * Idempotent — a no-op role change writes nothing. A non-member target 404s
 * (no existence oracle), an unknown role 400s.
 *
 * INVARIANT — a workspace always has >= 1 owner:
 *   - PROMOTE only ADDS an owner, so it can never zero the owner set: a plain
 *     role-guarded `updateMany`, no lock, no transaction.
 *   - DEMOTE (including SELF-demotion) can REMOVE the last owner, so it runs
 *     inside a `$transaction` that FIRST takes a Postgres transaction-scoped
 *     advisory lock keyed `ws-owners:<workspaceId>` — the SAME key
 *     `POST /api/workspaces/leave`'s owner path takes, so a concurrent
 *     demote and owner-leave on one workspace serialize and cannot race it to
 *     zero owners — then RE-READS the owner count INSIDE the lock. If the
 *     target is the last owner (count < 2) it refuses with 400; otherwise it
 *     demotes via a conditional `updateMany`. `pg_advisory_xact_lock`
 *     auto-releases at commit/rollback (the `ensurePersonalWorkspace`
 *     precedent, src/lib/workspace.ts).
 *
 * Self-demotion needs no special case: it flows through that same last-owner
 * guard, so an owner may step down to member iff another owner remains.
 */
export async function PATCH(request: Request, { params }: MemberRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  // Per-user throttle on this mutation endpoint (same shared 429 envelope as
  // the posts mutations). After the owner gate — the throttle is on the
  // endpoint, not the outcome — but before ANY membership read/write.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/members",
    limit: 60,
    windowMs: 5 * 60 * 1000,
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
  const refusal = renderedWorkspaceRefusal(body.workspaceId, context.workspace.id);
  if (refusal) {
    return refusal;
  }
  const role = body.role;
  if (role !== "owner" && role !== "member") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  const { userId: targetUserId } = await params;
  const workspaceId = context.workspace.id;

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: targetUserId },
    select: { role: true },
  });
  if (!membership) {
    return memberGone();
  }

  // Idempotent: already the requested role — write nothing.
  if (membership.role === role) {
    return NextResponse.json({ ok: true, role }, { status: 200 });
  }

  // Promote member -> owner. Adding an owner can never drop the workspace to
  // zero owners, so no advisory lock / transaction is needed. The `role:
  // "member"` guard keeps the update conditional (a concurrent change between
  // the read and the write matches nothing -> 404).
  if (role === "owner") {
    const { count } = await prisma.workspaceMember.updateMany({
      where: { workspaceId, userId: targetUserId, role: "member" },
      data: { role: "owner" },
    });
    if (count === 0) {
      return (await stillMember(prisma, workspaceId, targetUserId)) ? roleChanged() : memberGone();
    }
    return NextResponse.json({ ok: true, role }, { status: 200 });
  }

  // Demote owner -> member. This CAN remove the last owner, so serialize on the
  // shared ws-owners advisory lock and re-read the owner count INSIDE it.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${workspaceId}`}))`;

    const ownerCount = await tx.workspaceMember.count({
      where: { workspaceId, role: "owner" },
    });
    if (ownerCount < 2) {
      return "last_owner" as const;
    }

    const { count } = await tx.workspaceMember.updateMany({
      where: { workspaceId, userId: targetUserId, role: "owner" },
      data: { role: "member" },
    });
    if (count === 0) {
      return (await stillMember(tx, workspaceId, targetUserId)) ? ("role_changed" as const) : ("not_found" as const);
    }
    // R8-client-journey L1 / security L2: as on leave, the invite links they
    // made as an owner stop working with their ownership (same transaction),
    // so a copy they kept can't add anyone.
    const revoked = await tx.workspaceInvite.updateMany({
      where: { workspaceId, createdById: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { joinLinksRevoked: revoked.count };
  });
  if (outcome === "last_owner") {
    return NextResponse.json({ error: "Promote another owner first." }, { status: 400 });
  }
  if (outcome === "not_found") {
    return memberGone();
  }
  if (outcome === "role_changed") {
    return roleChanged();
  }

  // R5-security L1: as an owner they could copy the client links, which keep
  // working, so the other owners are emailed. After the commit; never throws.
  // The Team card reads which links still work itself (GET client-links).
  await noticeOwnersOfFormerOwner({
    workspaceId,
    workspaceName: context.workspace.name,
    formerOwnerId: targetUserId,
    at: new Date(),
    joinLinksRevoked: outcome.joinLinksRevoked,
    demoted: true,
  });
  // R9-client-journey L1: the Team card drops the invite link it shows when it was turned off.
  return NextResponse.json({ ok: true, role, joinLinksRevoked: outcome.joinLinksRevoked }, { status: 200 });
}
