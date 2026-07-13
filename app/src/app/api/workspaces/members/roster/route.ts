import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

/**
 * GET /api/workspaces/members/roster
 *
 * Member-safe roster (design §7 "member view: names only"): any member of
 * the active workspace gets display names + roles — NEVER emails or user
 * ids (SEC-1; the owner-only GET /api/workspaces/members is the full
 * variant). `name` falls back to the email local-part with the exact
 * post-attribution rule (see GET /api/posts createdBy), so both surfaces
 * show the same label for the same person; the full email never leaves
 * the server on this route.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { workspaceId: context.workspace.id },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    members: memberships.map((membership) => ({
      name: membership.user.name ?? membership.user.email.split("@")[0],
      role: membership.role,
    })),
  });
}
