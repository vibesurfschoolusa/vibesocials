import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
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
 * Owner-role targets are equally non-removable (review fix round 1, Minor 2
 * — future-proofs multi-owner states, where "remove the other owner" must
 * be an explicit transfer/demotion flow, not a member delete): the role is
 * read for the 400-vs-404 disambiguation, and the guard is REPEATED in the
 * delete's where clause (`role: { not: "owner" }`, conditional-mutation
 * pattern) so a promotion racing between the read and the delete still
 * can't remove an owner — the delete then matches nothing and 404s.
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
