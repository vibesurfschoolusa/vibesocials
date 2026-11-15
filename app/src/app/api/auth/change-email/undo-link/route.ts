import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";

const RATE_LIMIT = { route: "auth/change-email-undo-off", limit: 5, windowMs: 15 * 60 * 1000 } as const;

/**
 * The undo links that still work for this person: made by a change to the
 * address they sign in with now, not used, not turned off, not expired.
 */
function liveUndoLinks(user: { id: string; email: string }, now: Date) {
  return {
    userId: user.id,
    newEmail: user.email,
    usedAt: { not: null },
    undoneAt: null,
    undoTurnedOffAt: null,
    undoExpiresAt: { gt: now },
  };
}

/**
 * GET /api/auth/change-email/undo-link (R5 new-customer L4, review 2)
 *
 * Until when the previous address can undo the last email change
 * (../undo), for Settings, Account. `until` is null when it can't.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const live = await prisma.emailChangeRequest.findFirst({
      where: liveUndoLinks(user, new Date()),
      orderBy: { undoExpiresAt: "desc" },
      select: { undoExpiresAt: true },
    });
    return NextResponse.json({ until: live?.undoExpiresAt?.toISOString() ?? null });
  } catch (error) {
    logger.error("[GET /api/auth/change-email/undo-link] Unexpected error", { error });
    return NextResponse.json({ error: "We couldn't read the undo link. Reload the page to try again." }, { status: 500 });
  }
}

/**
 * DELETE /api/auth/change-email/undo-link { currentPassword }
 *
 * Turns the undo link off, for someone moving away from a lost or hacked
 * mailbox: whoever reads the previous address could otherwise take the
 * account back for 7 days. The current password is asked, as for the change
 * itself, and the limiter fails closed because it guards a password check.
 */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({ userId: user.id, ...RATE_LIMIT, failClosed: true });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many tries in the last few minutes. Wait 15 minutes, then try again.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const { currentPassword } = body;

  if (
    !user.passwordHash ||
    typeof currentPassword !== "string" ||
    !(await bcrypt.compare(currentPassword, user.passwordHash))
  ) {
    return NextResponse.json({ error: "Your current password is not correct." }, { status: 400 });
  }

  try {
    const now = new Date();
    const { count } = await prisma.emailChangeRequest.updateMany({
      where: liveUndoLinks(user, now),
      data: { undoTurnedOffAt: now },
    });
    if (count === 0) {
      return NextResponse.json(
        { error: "There is no undo link to turn off: it was already used, turned off or has expired." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[DELETE /api/auth/change-email/undo-link] Unexpected error", { error });
    return NextResponse.json(
      { error: "The undo link is still on: we couldn't turn it off just now. Please try again in a minute." },
      { status: 500 },
    );
  }
}
