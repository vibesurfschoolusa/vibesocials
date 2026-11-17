import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";

/**
 * Review of T1, items 2 and 3: the once-per-window emails claim their window
 * with a limit-1 counter (consumeFixedWindow). When the email then fails, the
 * claim is let go, so the next refusal or scan tries again instead of the
 * window passing with no email. Never throws.
 */
export async function releaseOnceADayKey(key: string): Promise<void> {
  try {
    await prisma.rateLimitEntry.deleteMany({ where: { key } });
  } catch (error) {
    logger.error("[notifications] Couldn't let go of a once-per-window email key (it opens again when its window ends)", {
      error,
    });
  }
}

/**
 * How long Resend remembers an idempotency key. Inside it a reused key stops a
 * second copy; past it, it does not.
 */
const IDEMPOTENCY_KEY_MS = 24 * 60 * 60 * 1000;

export type OncePerWindow = {
  key: string;
  resetAt: Date;
  /**
   * Every send carries a key for its recipient and this window (not per post
   * or per try), so within 24 hours a send without the claim can't be a
   * second copy. Only then may a store error still send.
   */
  perRecipientKeys?: boolean;
};

/**
 * R38 client-journey L2, R39 client-journey L2 and lead review: the one rule
 * for every once-per-window email (an hour, a day, a month). Claims
 * `window.key` until `window.resetAt`, runs `send`, and lets the claim go
 * unless `send` answers true (at least one email went).
 *
 * A throw from `send` goes to `onError`, the caller's own log line, and lets
 * the claim go, except when `send` had called `sendStarted` (an email may have
 * gone, its reply lost) and the window outlasts IDEMPOTENCY_KEY_MS: then a
 * later try could be a second copy, so the claim is kept. A throw before any
 * send started (a failed read) always lets it go.
 *
 * A claim store that can't answer: with a window of 24 hours or less and
 * per-recipient keys, it sends anyway and the keys stop repeats; otherwise it
 * sends nothing and the next trigger tries again. Never throws.
 *
 * "skipped": already sent in this window, or the store answered "unavailable"
 * and nothing was sent. "failed": nothing went, a send threw, or the claim
 * threw and nothing was sent.
 */
export async function sendOncePer(
  window: OncePerWindow,
  send: (sendStarted: () => void) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<"sent" | "skipped" | "failed"> {
  const { key, resetAt } = window;
  const withinKeys = resetAt.getTime() - Date.now() <= IDEMPOTENCY_KEY_MS;
  let storeDown = false;
  let claimThrew = false;
  let claimed = false;
  try {
    const claim = await consumeFixedWindow({ key, limit: 1, resetAt, failClosed: true });
    claimed = claim.allowed;
    storeDown = !claim.allowed && claim.unavailable === true;
  } catch (error) {
    onError(error);
    storeDown = claimThrew = true;
  }
  if (!claimed && !(storeDown && withinKeys && window.perRecipientKeys)) return claimThrew ? "failed" : "skipped";

  let started = false;
  try {
    if (await send(() => (started = true))) return "sent";
  } catch (error) {
    onError(error);
    if (started && !withinKeys) return "failed";
  }
  if (claimed) await releaseOnceADayKey(key);
  return "failed";
}

/** sendOncePer with a day's window: the name the daily emails already use. */
export function sendOnceADay(
  key: string,
  resetAt: Date,
  send: (sendStarted: () => void) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<"sent" | "skipped" | "failed"> {
  return sendOncePer({ key, resetAt }, send, onError);
}

/**
 * R39 client-journey L3: the one rule for an email to several people. Sends
 * to each recipient in turn; a throw (a retryable failure under
 * throwOnRetryable) never stops the next one. When any threw, the first error
 * is thrown once all were tried, so sendOncePer lets the window go and a later
 * try reaches them; each recipient's own idempotency key stops a second copy
 * to those it already reached. Otherwise answers whether any email went.
 * `sendStarted` (sendOncePer's) is called before each send.
 */
export async function sendToEach<T>(
  recipients: readonly T[],
  sendOne: (recipient: T) => Promise<boolean>,
  sendStarted: () => void = () => {},
): Promise<boolean> {
  let sent = false;
  let failure: { error: unknown } | null = null;
  for (const recipient of recipients) {
    try {
      sendStarted();
      if (await sendOne(recipient)) sent = true;
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return sent;
}
