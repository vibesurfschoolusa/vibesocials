/**
 * Send again (Activity) sends a post that was never sent. A post from weeks or
 * months ago would publish stale content today, so only a recent one may be
 * sent again; an older one is created again on purpose. The card and the
 * publish route both use this rule.
 */
export const SEND_AGAIN_MAX_AGE_DAYS = 7;

export const TOO_OLD_TO_SEND_MESSAGE =
  "This post was not sent, and it is too old to send again. Create it again if you still want it.";

/**
 * R49 pages-b L1: the Story half of a Feed and Story post has its own card;
 * its feed post may be out, so its step creates the Story alone (Create's
 * "post to" choice), not the whole post again.
 */
export const STORY_TOO_OLD_TO_SEND_MESSAGE =
  "This Story was not sent, and it is too old to send again. If you still want it, create a new post with Story chosen, not Feed and Story, so the feed post is not sent twice.";

/**
 * R49 pages-b L1 (5b), one rule: the too-old sentence for a job, the Story's
 * for a Story half. The Activity card and the publish route's 409 both say it.
 */
export function tooOldToSendText(storyHalf: boolean): string {
  return storyHalf ? STORY_TOO_OLD_TO_SEND_MESSAGE : TOO_OLD_TO_SEND_MESSAGE;
}

type When = Date | string | null | undefined;

function toMs(value: When): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when the post's time (its schedule, else its creation) is more than the limit ago, or unknown. */
export function sendAgainTooOld(job: { scheduledFor: When; createdAt: When }, now: number): boolean {
  const at = toMs(job.scheduledFor) ?? toMs(job.createdAt);
  if (at === null) return true;
  return now - at > SEND_AGAIN_MAX_AGE_DAYS * 86_400_000;
}
