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

type Db = { emailChangeRequest: Pick<Prisma.TransactionClient["emailChangeRequest"], "findFirst" | "deleteMany"> };

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
 * R6-pages L6, R7-pages L1 / security L2: a request row is kept only while it
 * is needed, then deleted with every address on it: a change once its undo
 * window has passed (undone or not), and a link with no window (never used,
 * or a change from an address that was never confirmed, which opens none)
 * once the link itself has expired. So after A -> B -> C neither A nor B is
 * left in a row, and a mistyped address in an unused link goes too.
 *
 * Run for every account at once by the existing daily sweep
 * (jobs/orphanBlobSweep.ts), which keeps the privacy page's "within a day
 * after the 72 hours" true, and also by the account routes that read these
 * rows, so a passed row is usually gone sooner. Returns how many rows it
 * deleted; never throws, so it can't fail the request or the sweep it runs
 * in (0 on a failure).
 */
export async function clearPassedUndoWindows(db: Db, now: Date): Promise<number> {
  try {
    const { count } = await db.emailChangeRequest.deleteMany({
      where: {
        OR: [{ undoExpiresAt: { lte: now } }, { undoExpiresAt: null, expiresAt: { lte: now } }],
      },
    });
    return count;
  } catch (error) {
    logger.warn("[undoWindow] clearing passed undo windows failed", { error });
    return 0;
  }
}
