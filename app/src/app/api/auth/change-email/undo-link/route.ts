import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * The undo links that still work for this person: made by a change to the
 * address they sign in with now, not used, not expired.
 */
function liveUndoLinks(user: { id: string; email: string }, now: Date) {
  return {
    userId: user.id,
    newEmail: user.email,
    usedAt: { not: null },
    undoneAt: null,
    undoExpiresAt: { gt: now },
  };
}

/**
 * GET /api/auth/change-email/undo-link (R5 new-customer L4, review 2)
 *
 * Until when the previous address can undo the last email change
 * (../undo), for the line in Settings, Account. `until` is null when it
 * can't. Read-only: the link can't be turned off (see ../confirm).
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
