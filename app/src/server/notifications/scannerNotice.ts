import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";
import { utcDayKey, utcDayRange } from "@/lib/usageLimits";
import { deliverPostOutcomeNotification } from "@/server/notifications/postOutcomeEmail";

/**
 * R8-security L1: a scheduled post the scanner did not send (nothing it could
 * go to, or refused by the day's limits) costs no Inngest execution. Its owner
 * is told from the scanner's own step, with the outcome email every other
 * result uses (same preference, same membership check), at most once per
 * workspace per reason per UTC day however many posts it has, keyed like the
 * refused-connect email.
 */

export type ScanNoticeReason = "NO_CONNECTIONS" | "LIMIT_REACHED";

export type ScanNotice = { postJobId: string; userId: string; workspaceId: string; reason: ScanNoticeReason };

/** Never throws: the scan carries on whatever happens to the email. */
export async function notifyNotSentAtScan(notice: ScanNotice, now: Date = new Date()): Promise<void> {
  try {
    // Fail closed: a store error sends nothing rather than one email per post.
    const { allowed } = await consumeFixedWindow({
      key: `scan-notice:${notice.workspaceId}:${notice.reason}:${utcDayKey(now)}`,
      limit: 1,
      resetAt: utcDayRange(now).end,
      failClosed: true,
    });
    if (!allowed) return;
    // The post failed before it was sent, so there is no other half to wait for.
    await deliverPostOutcomeNotification({ userId: notice.userId, postJobId: notice.postJobId, afterPairWait: true });
  } catch (error) {
    logger.error("[scanner] Couldn't tell the owner about a post that was not sent (ignored)", {
      error,
      postJobId: notice.postJobId,
      reason: notice.reason,
    });
  }
}
