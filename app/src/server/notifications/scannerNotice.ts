import { logger } from "@/lib/logger";
import { utcDayKey, utcDayRange } from "@/lib/usageLimits";
import { sendOnceADay } from "@/server/notifications/onceADay";
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
 * can fix), the day's key is kept: the email may have gone with its reply
 * lost, and the email promises no second one that day.
 *
 * Answers whether the notice was dealt with (sent, already sent today, or
 * tried): false only when it was left for the pair (or that check failed), so
 * the scanner may still tell this recipient about another post of the chunk.
 */
export async function notifyNotSentAtScan(notice: ScanNotice, now: Date = new Date()): Promise<boolean> {
  const key = scanNoticeKey(notice, now);
  try {
    if (await pairPartnerStillToSend(notice.postJobId, now)) return false;
  } catch (error) {
    logger.error("[scanner] Couldn't check a post's pair before telling its owner (another post may tell them)", {
      error,
      postJobId: notice.postJobId,
    });
    return false;
  }
  // sendOnceADay: a store error sends nothing rather than one email per post.
  await sendOnceADay(
    key,
    utcDayRange(now).end,
    async (sendStarted) => {
      // Any other half is done or not due yet (checked above), so none is waited for.
      // It throws only a failure a retry can fix, and only from its send (R40 security
      // L2): Resend may have taken the email, and its key is per post, so the day is
      // kept rather than a later post sending a second notice.
      sendStarted();
      await deliverPostOutcomeNotification({
        userId: notice.userId,
        postJobId: notice.postJobId,
        afterPairWait: true,
        scanNotice: true,
      });
      return true;
    },
    (error) =>
      logger.error("[scanner] Couldn't tell the owner about a post that was not sent (not tried again today: it may have gone)", {
        error,
        postJobId: notice.postJobId,
        reason: notice.reason,
      }),
  );
  return true;
}
