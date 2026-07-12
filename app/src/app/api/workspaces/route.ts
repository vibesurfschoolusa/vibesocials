import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

/**
 * GET /api/workspaces
 *
 * Lists every workspace the caller belongs to, for the account-menu switcher
 * (design doc §4 / §7). `isActive` marks the membership matching the
 * resolved active workspace (cookie hint, else personal — see
 * `getWorkspaceContext`), so the client never has to duplicate that
 * resolution logic.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: context.user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    workspaces: memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      role: membership.role,
      isActive: membership.workspace.id === context.workspace.id,
    })),
  });
}
