import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { checkRateLimit } from "@/lib/rateLimit";

import { inviteLinkWorks, MAKER_NOT_OWNER_MESSAGE } from "./inviteMaker";
import { signedOutResponse } from "@/lib/signedOutResponse";

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
    return signedOutResponse();
  }

  // Post-release review (Task D): this preview GET was unguarded — per-user
  // throttle, distinct key from invites/accept's own 10/5min limit, same
  // shared 429 envelope as posts/[postJobId]'s enforceMutateRateLimit (body +
  // Retry-After header).
  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "invites/preview",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const { token } = await params;

  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { workspace: { select: { id: true, name: true } } },
  });

  // R9-client-journey L6 / R10: the one rule Join and the Team card apply (inviteMaker.ts).
  const works = invite ? await inviteLinkWorks(prisma, invite) : "dead";
  if (!invite || works === "dead") {
    return INVALID_INVITE_RESPONSE();
  }
  if (works === "maker_not_owner") {
    return NextResponse.json({ error: MAKER_NOT_OWNER_MESSAGE }, { status: 404 });
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: invite.workspaceId, userId: user.id },
  });

  return NextResponse.json(
    // R13-client-journey L1: the id, so an existing member's Go to dashboard opens this workspace.
    { workspaceId: invite.workspace.id, workspaceName: invite.workspace.name, alreadyMember: Boolean(membership) },
    { status: 200 },
  );
}
