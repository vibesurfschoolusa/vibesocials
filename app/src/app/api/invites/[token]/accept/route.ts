import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";

interface AcceptRouteContext {
  params: Promise<{ token: string }>;
}

const RATE_LIMIT = { route: "invites/accept", limit: 10, windowMs: 5 * 60 * 1000 } as const;

/**
 * POST /api/invites/[token]/accept
 *
 * Auth-only (see GET /api/invites/[token] for why this uses `getCurrentUser`
 * rather than `getWorkspaceContext`: the token names the target workspace,
 * not the caller's active one). Re-validates hash+expiry+revocation exactly
 * like the preview route (same uniform 404) since the preview and the actual
 * accept can race an expiring/revoked invite between the two calls.
 *
 * Idempotent for an already-existing member: `workspaceMember.upsert`'s
 * `update: {}` is a no-op when the (workspaceId, userId) row already exists
 * (never downgrades an existing owner/member's role), so the response shape
 * is identical — 200 { joined: true, workspaceId } — whether this call
 * created the membership or found it already there. This also closes the
 * double-accept TOCTOU race a separate find-then-create would have (mirrors
 * the advisory-locked provisioning core in src/lib/workspace.ts).
 */
export async function POST(_request: Request, { params }: AcceptRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({ userId: user.id, ...RATE_LIMIT });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const { token } = await params;

  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });

  if (!invite || invite.revokedAt || invite.expiresAt <= new Date()) {
    return NextResponse.json(
      { error: "This invite link is invalid or has expired." },
      { status: 404 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      });

      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
        create: { workspaceId: invite.workspaceId, userId: user.id, role: "member" },
        update: {},
      });
    });
  } catch (error) {
    logger.error("[POST /api/invites/[token]/accept] Unexpected error", {
      error,
      workspaceId: invite.workspaceId,
      userId: user.id,
    });
    return NextResponse.json({ error: "Failed to join workspace" }, { status: 500 });
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, invite.workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ joined: true, workspaceId: invite.workspaceId }, { status: 200 });
}
