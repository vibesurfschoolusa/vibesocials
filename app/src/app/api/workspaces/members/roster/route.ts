import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { personLabel } from "@/lib/usageLimits";
import { getWorkspaceContext } from "@/lib/workspace";

/**
 * GET /api/workspaces/members/roster
 *
 * Member-safe roster (design §7 "member view: names only"): any member of
 * the active workspace gets display names + roles — NEVER emails or user
 * ids (SEC-1; the owner-only GET /api/workspaces/members is the full
 * variant). `name` is the one person label's member rule
 * (personLabel(user, false), R15-new-customer L3): the name, else the email
 * local-part, as posts' "by" shows it to members; the full email never
 * leaves the server on this route, whoever reads it.
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
      name: personLabel(membership.user, false),
      role: membership.role,
    })),
  });
}
