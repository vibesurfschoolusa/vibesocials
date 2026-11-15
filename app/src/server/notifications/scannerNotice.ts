import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";
import { utcDayKey, utcDayRange } from "@/lib/usageLimits";
import { releaseOnceADayKey } from "@/server/notifications/onceADay";
import { deliverPostOutcomeNotification } from "@/server/notifications/postOutcomeEmail";

/**
 * R8-security L1: a scheduled post the scanner did not send (nothing it could
 * go to, or refused by the day's limits) costs no Inngest execution. Its owner
 * is told from the scanner's own step, with the outcome email every other
 * result uses (same preference, same membership check), at most once per
 * workspace, recipient and reason a UTC day however many posts it has (a
 * second author hears about their own), keyed like the refused-connect email.
 */

export type ScanNoticeReason = "NO_CONNECTIONS" | "LIMIT_REACHED";

export type ScanNotice = { postJobId: string; userId: string; workspaceId: string; reason: ScanNoticeReason };

/** The once-a-day key of a notice: its workspace, recipient, reason and UTC day. */
export function scanNoticeKey(notice: ScanNotice, now: Date): string {
  return `scan-notice:${notice.workspaceId}:${notice.userId}:${notice.reason}:${utcDayKey(now)}`;
}

/**
 * Never throws: the scan carries on whatever happens to the email. When the
 * send fails (deliverPostOutcomeNotification throws only a failure a retry
 * can fix), the day's key is let go, so the next scan's notice tries again.
 */
export async function notifyNotSentAtScan(notice: ScanNotice, now: Date = new Date()): Promise<void> {
  const key = scanNoticeKey(notice, now);
  let claimed = false;
  try {
    // Fail closed: a store error sends nothing rather than one email per post.
    claimed = (await consumeFixedWindow({ key, limit: 1, resetAt: utcDayRange(now).end, failClosed: true })).allowed;
    if (!claimed) return;
    // The post failed before it was sent, so there is no other half to wait for.
    await deliverPostOutcomeNotification({ userId: notice.userId, postJobId: notice.postJobId, afterPairWait: true });
  } catch (error) {
    logger.error("[scanner] Couldn't tell the owner about a post that was not sent (a later scan tries again)", {
      error,
      postJobId: notice.postJobId,
      reason: notice.reason,
    });
    if (claimed) await releaseOnceADayKey(key);
  }
}
