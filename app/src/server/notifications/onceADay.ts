import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

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
