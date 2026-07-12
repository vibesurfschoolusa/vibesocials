import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireOwnerContext } from "@/lib/workspace";

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
