import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";
import { JOIN_FAILED_MESSAGE } from "@/app/join/[token]/joinMessages";
import { notifyOwnersOfMemberJoined } from "@/server/notifications/memberJoinedEmail";

import { inviteLinkWorks, MAKER_NOT_OWNER_MESSAGE } from "../inviteMaker";
import { signedOutResponse } from "@/lib/signedOutResponse";

interface AcceptRouteContext {
  params: Promise<{ token: string }>;
}

const RATE_LIMIT = { route: "invites/accept", limit: 10, windowMs: 5 * 60 * 1000 } as const;

/** Uniform 404 for any invalid/expired/revoked token — no oracle beyond validity. */
const invalidInviteResponse = () =>
  NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });

/** R9-client-journey L6: the link's maker is no longer an owner (inviteMaker.ts). */
const makerNotOwnerResponse = () => NextResponse.json({ error: MAKER_NOT_OWNER_MESSAGE }, { status: 404 });

/**
 * POST /api/invites/[token]/accept
 *
 * Auth-only (see GET /api/invites/[token] for why this uses `getCurrentUser`
 * rather than `getWorkspaceContext`: the token names the target workspace,
 * not the caller's active one).
 *
 * Validation happens TWICE (review fix round 1, Important 1). The fast-path
 * read below gives a cheap uniform 404 for obviously-dead tokens without
 * opening a transaction — but alone it would be a TOCTOU hole: a revoke (or
 * expiry) landing between that read and the membership write would still
 * grant membership. The transaction therefore re-validates ATOMICALLY via a
 * conditional `updateMany` (`revokedAt: null`, `expiresAt > now` in the
 * WHERE, same conditional-mutation pattern as the posts cancel route and
 * members/[userId] DELETE): `count === 0` means the invite died in the
 * window — abort (nothing was mutated) and return the SAME uniform 404.
 * Only a matched guard (count 1) proceeds to the membership upsert, and the
 * cookie is set only after the transaction commits.
 *
 * Idempotent for an already-existing member: `createMany` with
 * `skipDuplicates` leaves an existing (workspaceId, userId) row alone (never
 * downgrades an existing owner/member's role), so the response shape is
 * identical — 200 { joined: true, workspaceId } — whether this call created
 * the membership or found it already there. This also closes the
 * double-accept TOCTOU race a separate find-then-create would have (mirrors
 * the advisory-locked provisioning core in src/lib/workspace.ts). Its count
 * says whether the row is new: R2-client-journey L3 emails the owners then,
 * and only then, so two racing accepts send one email.
 */
export async function POST(_request: Request, { params }: AcceptRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return signedOutResponse();
  }

  const rateLimit = await checkRateLimit({ userId: user.id, ...RATE_LIMIT });
  if (!rateLimit.allowed) {
    return tooManyTriesResponse(rateLimit);
  }

  const { token } = await params;

  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });

  if (!invite) {
    return invalidInviteResponse();
  }

  let joined: boolean | "maker_not_owner" = false;
  let added = false;
  try {
    joined = await prisma.$transaction(async (tx) => {
      // R10: the one rule the preview and the Team card apply (inviteMaker.ts),
      // read in this transaction, before the link is used.
      const works = await inviteLinkWorks(tx, invite);
      if (works !== true) {
        return works === "dead" ? false : works;
      }

      // Atomic re-validation + use-count bump in one statement (see the
      // route doc comment). Matching nothing mutates nothing, so the early
      // return commits an empty transaction — no rollback bookkeeping.
      const { count } = await tx.workspaceInvite.updateMany({
        where: { id: invite.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedCount: { increment: 1 } },
      });

      if (count === 0) {
        return false;
      }

      const created = await tx.workspaceMember.createMany({
        data: [{ workspaceId: invite.workspaceId, userId: user.id, role: "member" }],
        skipDuplicates: true,
      });
      added = created.count > 0;

      return true;
    });
  } catch (error) {
    logger.error("[POST /api/invites/[token]/accept] Unexpected error", {
      error,
      workspaceId: invite.workspaceId,
      userId: user.id,
    });
    return NextResponse.json({ error: JOIN_FAILED_MESSAGE }, { status: 500 });
  }

  if (joined === "maker_not_owner") {
    return makerNotOwnerResponse();
  }
  if (!joined) {
    return invalidInviteResponse();
  }

  if (added) {
    // Never throws: the person has joined whatever the email does.
    await notifyOwnersOfMemberJoined({
      workspaceId: invite.workspaceId,
      member: { name: user.name, email: user.email },
    });
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
