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
 * R44 platform L1: a claim is held from before its send until the send answers,
 * and a second path that finds it held can't tell from the claim alone whether
 * the email went or is still going (and may yet fail and be let go). So a send
 * that answered true leaves a second key, `<key>:reached`, until the window
 * ends: a held claim with it is "skipped", one without it is "held".
 */
function reachedKey(key: string): string {
  return `${key}:reached`;
}

/** Writes the reached mark. A store error is logged: the next try then reads "held" and tries later. */
async function markReached(key: string, resetAt: Date): Promise<void> {
  const mark = reachedKey(key);
  try {
    await prisma.rateLimitEntry.upsert({ where: { key: mark }, create: { key: mark, count: 1, expiresAt: resetAt }, update: {} });
  } catch (error) {
    logger.error("[notifications] Couldn't mark a once-per-window email as reached (a later try reads it as not yet answered)", {
      error,
    });
  }
}

/** Whether the send under a held claim has answered. A store error reads as not yet. */
async function wasReached(key: string): Promise<boolean> {
  try {
    return (await prisma.rateLimitEntry.findUnique({ where: { key: reachedKey(key) } })) !== null;
  } catch {
    return false;
  }
}

/**
 * How long Resend remembers an idempotency key. Inside it a reused key stops a
 * second copy; past it, it does not.
 */
const IDEMPOTENCY_KEY_MS = 24 * 60 * 60 * 1000;

/**
 * R40 lead review: a send the email layer marks as certainly not sent
 * (`emailNotSent: true`, set by email.ts on Resend's 429 only). Read by the
 * mark rather than by class, so this rule never needs email.ts loaded.
 */
function certainlyNotSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { emailNotSent?: unknown }).emailNotSent === true;
}

export type OncePerOutcome = "sent" | "skipped" | "held" | "failed";

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
   * its first email sent: the window's start for one claimed only while it
   * runs (the current hour, day or month). null: no bound, such as a day that
   * can be filled days ahead. Required, so no window can leave it out.
   */
  keysFrom: Date | null;
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
 * started (a failed read), or one marked certainly not sent (Resend's 429),
 * always lets it go.
 *
 * A claim store that can't answer: with per-recipient keys, a window that ends
 * within IDEMPOTENCY_KEY_MS and a key first usable no more than
 * IDEMPOTENCY_KEY_MS ago (R40 security L1: so any email it already sent is one
 * Resend still remembers), it sends anyway and the keys stop repeats;
 * otherwise it sends nothing and the next trigger tries again. Never throws.
 *
 * "skipped": already sent in this window (the claim's send answered, R44).
 * "held": the claim is held but its send has not answered: still going, or
 * failing and about to be let go, so a caller records nothing on it and tries
 * again later. "failed": nothing went, a send threw, or the claim store failed
 * and nothing was sent.
 */
export async function sendOncePer(
  window: OncePerWindow,
  send: (sendStarted: () => void) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<OncePerOutcome> {
  const { key, resetAt } = window;
  const now = Date.now();
  const keysCoverLater = window.perRecipientKeys === true && resetAt.getTime() - now <= IDEMPOTENCY_KEY_MS;
  const keysCoverEarlier = window.keysFrom !== null && now - window.keysFrom.getTime() <= IDEMPOTENCY_KEY_MS;
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
  if (!claimed && !(storeDown && keysCoverLater && keysCoverEarlier)) {
    if (storeDown) return "failed";
    return (await wasReached(key)) ? "skipped" : "held";
  }

  let started = false;
  try {
    if (await send(() => (started = true))) {
      await markReached(key, resetAt);
      return "sent";
    }
  } catch (error) {
    onError(error);
    if (started && !keysCoverLater && !certainlyNotSent(error)) return "failed";
  }
  if (claimed) await releaseOnceADayKey(key);
  return "failed";
}

/**
 * sendOncePer with a day's window and no per-recipient keys: the name the
 * daily emails already use. Without the keys a store error never sends, so
 * the window's start is not needed.
 */
export function sendOnceADay(
  key: string,
  resetAt: Date,
  send: (sendStarted: () => void) => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<OncePerOutcome> {
  return sendOncePer({ key, resetAt, keysFrom: null }, send, onError);
}

/**
 * R39 client-journey L3: the one rule for an email to several people. Sends
 * to each recipient in turn; a throw (a retryable failure under
 * throwOnRetryable) never stops the next one. When any threw, the first error
 * is thrown once all were tried (the first unmarked one when some were marked
 * certainly not sent, R40 lead review), so sendOncePer lets the window go when
 * the keys allow and a later try reaches them (it carries the "not sent" mark
 * only when nobody was sent in this call); each recipient's own
 * idempotency key stops a second copy to those it already reached. Otherwise answers whether any email went.
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
      // An unknown outcome outranks a "not sent" one, so the window is let go
      // only when every failed send certainly didn't go.
      if (!failure || (certainlyNotSent(failure.error) && !certainlyNotSent(error))) failure = { error };
    }
  }
  if (failure) {
    // R40 last look: "not sent" holds for the whole call only when nobody was
    // sent; otherwise the keys' rule decides, so a reached recipient never gets
    // a second copy after their key is forgotten.
    if (sent && certainlyNotSent(failure.error)) {
      throw new Error("A send was refused after another recipient was sent", { cause: failure.error });
    }
    throw failure.error;
  }
  return sent;
}
