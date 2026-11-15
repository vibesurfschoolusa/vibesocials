import type { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";

/**
 * The "This wasn't me: undo" window of an email change (R6-security M1).
 * The undo (api/auth/change-email/undo) puts the previous address back, so
 * while it is open nothing may take that address or move the account on:
 * the account can't change its email again, and no other account can be
 * registered with, changed to, or created by Google sign-in on the previous
 * address. Without that a hijacker could change A -> B -> C, or register A
 * elsewhere, and the undo would no longer work.
 */

type Db = { emailChangeRequest: Pick<Prisma.TransactionClient["emailChangeRequest"], "findFirst" | "updateMany"> };

/** Until when this account's last email change can still be undone, or null. */
export async function accountUndoWindowUntil(db: Db, userId: string, now: Date): Promise<Date | null> {
  const open = await db.emailChangeRequest.findFirst({
    where: { userId, usedAt: { not: null }, undoneAt: null, undoExpiresAt: { gt: now } },
    orderBy: { undoExpiresAt: "desc" },
    select: { undoExpiresAt: true },
  });
  return open?.undoExpiresAt ?? null;
}

/** Until when an open undo window may put this address back on its account, or null. */
export async function addressHeldUntil(db: Db, email: string, now: Date): Promise<Date | null> {
  const open = await db.emailChangeRequest.findFirst({
    where: { previousEmail: email, undoneAt: null, undoExpiresAt: { gt: now } },
    orderBy: { undoExpiresAt: "desc" },
    select: { undoExpiresAt: true },
  });
  return open?.undoExpiresAt ?? null;
}

/**
 * R6-pages L6: the previous address is kept only while it can undo. Cleared
 * lazily, for every account at once, by the account routes that read these
 * rows (Settings, Account reads the undo line on every visit), so no
 * scheduled job is spent on it. Never throws: it must not fail that request.
 */
export async function clearPassedUndoWindows(db: Db, now: Date): Promise<void> {
  try {
    await db.emailChangeRequest.updateMany({
      where: {
        undoExpiresAt: { lte: now },
        OR: [{ previousEmail: { not: null } }, { undoTokenHash: { not: null } }],
      },
      data: { previousEmail: null, undoTokenHash: null },
    });
  } catch (error) {
    logger.warn("[undoWindow] clearing passed undo windows failed", { error });
  }
}
