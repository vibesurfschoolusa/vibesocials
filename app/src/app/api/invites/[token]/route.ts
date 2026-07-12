import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";

interface InviteRouteContext {
  params: Promise<{ token: string }>;
}

/** Shared 404 body for any invalid/expired/revoked token (see GET below). */
const INVALID_INVITE_RESPONSE = () =>
  NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });

/**
 * GET /api/invites/[token]
 *
 * Auth-only preview of an invite link — deliberately uses `getCurrentUser`
 * rather than `getWorkspaceContext`: this route resolves a workspace named
 * by the URL TOKEN, not the caller's own active workspace, so
 * `getWorkspaceContext`'s active-workspace resolution doesn't apply (mirrors
 * design doc §3's page/API split: plain auth gate here, no workspace
 * resolution needed). 404 uniformly for unknown/expired/revoked tokens (no
 * oracle beyond validity) — see the join page (Task 7), which shows one
 * generic error state either way.
 */
export async function GET(_request: Request, { params }: InviteRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token } = await params;

  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { workspace: { select: { id: true, name: true } } },
  });

  if (!invite || invite.revokedAt || invite.expiresAt <= new Date()) {
    return INVALID_INVITE_RESPONSE();
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: invite.workspaceId, userId: user.id },
  });

  return NextResponse.json(
    { workspaceName: invite.workspace.name, alreadyMember: Boolean(membership) },
    { status: 200 },
  );
}
