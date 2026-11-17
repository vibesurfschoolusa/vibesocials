import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";

/**
 * Review of T1, items 2 and 3: the once-a-day emails claim their day with a
 * limit-1 counter (consumeFixedWindow). When the email then fails, the claim
 * is let go, so the next refusal or scan tries again instead of the day
 * passing with no email. Never throws.
 */
export async function releaseOnceADayKey(key: string): Promise<void> {
  try {
    await prisma.rateLimitEntry.deleteMany({ where: { key } });
  } catch (error) {
    logger.error("[notifications] Couldn't let go of a once-a-day email key (it opens again tomorrow)", { error });
  }
}

/**
 * R38 client-journey L2: the one rule for every once-a-day email. Claims
 * `key` until `resetAt` (fail closed: a store that can't answer sends nothing
 * rather than one email per try), runs `send`, and lets the claim go unless
 * `send` answers true (at least one email went). A throw from `send` (a read
 * or a send) goes to `onError`, the caller's own log line, and lets the claim
 * go too. Never throws.
 *
 * "skipped": already sent today, or the store couldn't answer. "failed":
 * nothing went (a claim that was held is let go).
 */
export async function sendOnceADay(
  key: string,
  resetAt: Date,
  send: () => Promise<boolean>,
  onError: (error: unknown) => void,
): Promise<"sent" | "skipped" | "failed"> {
  let claimed = false;
  try {
    claimed = (await consumeFixedWindow({ key, limit: 1, resetAt, failClosed: true })).allowed;
    if (!claimed) return "skipped";
    if (await send()) return "sent";
  } catch (error) {
    onError(error);
  }
  if (claimed) await releaseOnceADayKey(key);
  return "failed";
}
