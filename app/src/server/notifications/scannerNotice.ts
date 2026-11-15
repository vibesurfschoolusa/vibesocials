import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";
import { utcDayKey, utcDayRange } from "@/lib/usageLimits";
import { releaseOnceADayKey } from "@/server/notifications/onceADay";
import { deliverPostOutcomeNotification, pairPartnerStillToSend } from "@/server/notifications/postOutcomeEmail";

/**
 * R8-security L1: a scheduled post the scanner did not send (nothing it could
 * go to, or refused by the day's limits) costs no Inngest execution. Its owner
 * is told from the scanner's own step, with the outcome email every other
 * result uses (same preference, same membership check), at most once per
 * workspace, recipient and reason a UTC day however many posts it has (a
 * second author hears about their own), keyed like the refused-connect email.
 *
 * R9-publishing L1: a Feed and Story pair gets one email. A half whose other
 * half is still to be sent (publishing, or due in this scan) is not told about
 * here and does not use up the day's key: the other half's run sends the
 * pair's one email, this half's rows in it.
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
    if (await pairPartnerStillToSend(notice.postJobId, now)) return;
    // Fail closed: a store error sends nothing rather than one email per post.
    claimed = (await consumeFixedWindow({ key, limit: 1, resetAt: utcDayRange(now).end, failClosed: true })).allowed;
    if (!claimed) return;
    // Any other half is done or not due yet (checked above), so none is waited for.
    await deliverPostOutcomeNotification({
      userId: notice.userId,
      postJobId: notice.postJobId,
      afterPairWait: true,
      scanNotice: true,
    });
  } catch (error) {
    logger.error("[scanner] Couldn't tell the owner about a post that was not sent (a later scan tries again)", {
      error,
      postJobId: notice.postJobId,
      reason: notice.reason,
    });
    if (claimed) await releaseOnceADayKey(key);
  }
}
