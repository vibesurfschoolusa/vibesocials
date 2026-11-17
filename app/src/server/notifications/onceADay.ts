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
  /**
   * R40 security L1: the earliest time this window's key could be claimed, so
   * its first email sent. Omitted: `resetAt` minus 24 hours (a window of a day
   * or less, claimed only while it runs, such as the current hour or day).
   * null: no bound, such as a day that can be filled days ahead.
   */
  keysFrom?: Date | null;
};

/**
 * R38 client-journey L2, R39 client-journey L2 and lead review: the one rule
 * for every once-per-window email (an hour, a day, a month). Claims
 * `window.key` until `window.resetAt`, runs `send`, and lets the claim go
 * unless `send` answers true (at least one email went).
 *
 * A throw from `send` goes to `onError`, the caller's own log line, and lets
 * the claim go. Except when `send` had called `sendStarted` (an email may have
 * gone, its reply lost): then it is let go only with per-recipient keys and a
 * window that ends within IDEMPOTENCY_KEY_MS, where each key still stops any
 * later try being a second copy (R40 security L2). A throw before any send
 * started (a failed read) always lets it go.
 *
 * A claim store that can't answer: with per-recipient keys, a window that ends
 * within IDEMPOTENCY_KEY_MS and a key first usable no more than
 * IDEMPOTENCY_KEY_MS ago (R40 security L1: so any email it already sent is one
 * Resend still remembers), it sends anyway and the keys stop repeats;
 * otherwise it sends nothing and the next trigger tries again. Never throws.
 *
 * "skipped": already sent in this window. "failed": nothing went, a send
 * threw, or the claim store failed and nothing was sent.
 */
export async function sendOncePer(
  window: OncePerWindow,
  send: (sendStarted: () => void) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<"sent" | "skipped" | "failed"> {
  const { key, resetAt } = window;
  const now = Date.now();
  const keysCoverLater = window.perRecipientKeys === true && resetAt.getTime() - now <= IDEMPOTENCY_KEY_MS;
  const keysFrom = window.keysFrom === undefined ? resetAt.getTime() - IDEMPOTENCY_KEY_MS : window.keysFrom?.getTime();
  const keysCoverEarlier = keysFrom !== undefined && now - keysFrom <= IDEMPOTENCY_KEY_MS;
  let storeDown = false;
  let claimed = false;
  try {
    const claim = await consumeFixedWindow({ key, limit: 1, resetAt, failClosed: true });
    claimed = claim.allowed;
    storeDown = !claim.allowed && claim.unavailable === true;
  } catch (error) {
    onError(error);
    storeDown = true;
  }
  if (!claimed && !(storeDown && keysCoverLater && keysCoverEarlier)) return storeDown ? "failed" : "skipped";

  let started = false;
  try {
    if (await send(() => (started = true))) return "sent";
  } catch (error) {
    onError(error);
    if (started && !keysCoverLater) return "failed";
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
