import { prisma } from "@/lib/db";

/** Paid Google lookups the whole app makes in a UTC day (F5). */
export const GEOCODE_APP_DAILY_LIMIT = 2000;

export type GeocodeAppDayResult =
  | { outcome: "allowed" }
  | { outcome: "limit"; retryAfterSeconds: number }
  | { outcome: "unavailable" };

/**
 * Count one lookup against the app's UTC day. The same row as lib/rateLimit.ts
 * consumeFixedWindow, but a store error is told apart from a used-up day, so
 * the person is not told suggestions are off until tomorrow when the database
 * only blinked. Either way no paid call is made.
 */
export async function consumeGeocodeAppDay(now: Date = new Date()): Promise<GeocodeAppDayResult> {
  const day = now.toISOString().slice(0, 10);
  const key = `geocode:app:${day}`;
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  try {
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: resetAt },
      update: { count: { increment: 1 } },
    });
    if (entry.count <= GEOCODE_APP_DAILY_LIMIT) return { outcome: "allowed" };
    return {
      outcome: "limit",
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
    };
  } catch (error) {
    console.error("[Geocode] Couldn't count the app's lookups; none is made", error);
    return { outcome: "unavailable" };
  }
}
