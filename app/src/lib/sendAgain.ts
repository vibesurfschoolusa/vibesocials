/**
 * Send again (Activity) sends a post that was never sent. A post from weeks or
 * months ago would publish stale content today, so only a recent one may be
 * sent again; an older one is created again on purpose. The card and the
 * publish route both use this rule.
 */
export const SEND_AGAIN_MAX_AGE_DAYS = 7;

export const TOO_OLD_TO_SEND_MESSAGE =
  "This post was not sent, and it is too old to send again. Create it again if you still want it.";

/** The route's refusal for a post older than the rule allows. */
export const TOO_OLD_TO_SEND_ERROR = "This post is too old to send again. Create it again.";

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
