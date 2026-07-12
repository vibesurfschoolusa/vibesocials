import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getWorkspaceContext, WorkspaceForbiddenError, type WorkspaceContext } from "@/lib/workspace";

interface MemberRouteContext {
  params: Promise<{ userId: string }>;
}

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
 * DELETE /api/workspaces/members/[userId]
 *
 * Owner-only member removal (design doc §4). v1 has no ownership-transfer
 * flow (out of scope — design doc §10), so the owner can never remove
 * themselves; they'd be left with an ownerless workspace. This is checked
 * BEFORE the not-a-member lookup since the owner is always a member of their
 * own active workspace, so a self-removal attempt would otherwise reach the
 * (misleading) 404 branch instead of the correct 400.
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

  const { count } = await prisma.workspaceMember.deleteMany({
    where: { workspaceId: context.workspace.id, userId: targetUserId },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
