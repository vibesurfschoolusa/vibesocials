import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
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
 * GET /api/workspaces/members
 *
 * Owner-only member list (design doc §4, SEC-1: members' emails are
 * workspace-internal data, so this route is never exposed to non-owners —
 * there is no member-visible variant).
 */
export async function GET() {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  const memberships = await prisma.workspaceMember.findMany({
    where: { workspaceId: context.workspace.id },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    members: memberships.map((membership) => ({
      userId: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      role: membership.role,
      joinedAt: membership.createdAt.toISOString(),
    })),
  });
}
