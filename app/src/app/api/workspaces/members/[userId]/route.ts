import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext } from "@/lib/workspace";

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
 * round 1, Minor 2). Multi-owner now exists (Task D1), so removing a co-owner
 * is the explicit demotion flow this guard always anticipated —
 * `PATCH /api/workspaces/members/[userId] { role: "member" }`, not a member
 * delete. The role is still read for the 400-vs-404 disambiguation, and the
 * guard is REPEATED in the delete's where clause (`role: { not: "owner" }`,
 * conditional-mutation pattern) so a promotion racing between the read and the
 * delete still can't remove an owner — the delete then matches nothing and
 * 404s. To remove a co-owner: demote them via PATCH first, then DELETE.
 */
export async function DELETE(_request: Request, { params }: MemberRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (membership.role === "owner") {
    return NextResponse.json({ error: "Owners can't be removed." }, { status: 400 });
  }

  const { count } = await prisma.workspaceMember.deleteMany({
    where: { workspaceId: context.workspace.id, userId: targetUserId, role: { not: "owner" } },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
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

  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = body?.role;
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, role }, { status: 200 });
  }

  // Demote owner -> member. This CAN remove the last owner, so serialize on the
  // shared ws-owners advisory lock and re-read the owner count INSIDE it.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${workspaceId}`}))`;

    const ownerCount = await tx.workspaceMember.count({
      where: { workspaceId, role: "owner" },
    });
    if (ownerCount < 2) {
      return NextResponse.json({ error: "Promote another owner first." }, { status: 400 });
    }

    const { count } = await tx.workspaceMember.updateMany({
      where: { workspaceId, userId: targetUserId, role: "owner" },
      data: { role: "member" },
    });
    if (count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, role }, { status: 200 });
  });
}
