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
 * How long Resend remembers an idempotency key. Letting a window go after a
 * send that threw is safe only while a second try's reused key still stops a
 * second copy (the send may have gone and only its reply was lost).
 */
const IDEMPOTENCY_KEY_MS = 24 * 60 * 60 * 1000;

/**
 * R38 client-journey L2, R39 client-journey L2: the one rule for every
 * once-per-window email (an hour, a day, a month). Claims `window.key` until
 * `window.resetAt` (fail closed: a store that can't answer sends nothing
 * rather than one email per try), runs `send`, and lets the claim go unless
 * `send` answers true (at least one email went). A throw from `send` (a read
 * or a send) goes to `onError`, the caller's own log line, and lets the claim
 * go too, unless the window outlasts IDEMPOTENCY_KEY_MS: then a lost reply
 * could become a second copy, so the claim is kept. Never throws.
 *
 * "skipped": already sent in this window, or the store couldn't answer.
 * "failed": nothing went, or a send threw.
 */
export async function sendOncePer(
  window: { key: string; resetAt: Date },
  send: () => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<"sent" | "skipped" | "failed"> {
  const { key, resetAt } = window;
  let claimed = false;
  try {
    claimed = (await consumeFixedWindow({ key, limit: 1, resetAt, failClosed: true })).allowed;
    if (!claimed) return "skipped";
    if (await send()) return "sent";
  } catch (error) {
    onError(error);
    if (resetAt.getTime() - Date.now() > IDEMPOTENCY_KEY_MS) return "failed";
  }
  if (claimed) await releaseOnceADayKey(key);
  return "failed";
}

/** sendOncePer with a day's window: the name the daily emails already use. */
export function sendOnceADay(
  key: string,
  resetAt: Date,
  send: () => Promise<boolean>,
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
 */
export async function sendToEach<T>(
  recipients: readonly T[],
  sendOne: (recipient: T) => Promise<boolean>,
): Promise<boolean> {
  let sent = false;
  let failure: { error: unknown } | null = null;
  for (const recipient of recipients) {
    try {
      if (await sendOne(recipient)) sent = true;
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return sent;
}
