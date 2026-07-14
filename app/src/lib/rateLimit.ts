import { prisma } from "./db";

export interface CheckRateLimitOptions {
  /** Authenticated user id — the throttle key is per-user. */
  userId: string;
  /** Stable route identifier, e.g. "posts/auto-caption". */
  route: string;
  /** Maximum number of allowed requests within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * When true, a store error DENIES the request instead of allowing it.
   * Use for anonymous auth abuse surfaces (register / forgot / reset / verify)
   * where unlimited throughput during a DB outage is worse than a 429.
   * Product routes keep the default (fail open) so a limiter blip cannot take
   * publishing down.
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (only set when blocked). */
  retryAfterSeconds?: number;
}

/**
 * DB-backed fixed-window rate limiter.
 *
 * Buckets time into `windowMs` slices and counts requests per
 * `userId:route:bucket` key in Postgres, so the limit holds across all
 * serverless instances (an in-memory counter would multiply with horizontal
 * scale). Atomicity comes from a single DB upsert.
 *
 * Default Fails OPEN: any store error — including "table does not exist"
 * before the migration is applied — is logged loudly and the request is
 * allowed, so the limiter never takes a product route down. Pass
 * `failClosed: true` for anonymous auth routes.
 */
export async function checkRateLimit(
  opts: CheckRateLimitOptions,
): Promise<RateLimitResult> {
  const { userId, route, limit, windowMs, failClosed = false } = opts;

  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const key = `${userId}:${route}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * windowMs);

  try {
    // Atomic per-key increment; the DB serializes concurrent upserts.
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });

    // Opportunistic, fire-and-forget cleanup of expired rows (~2% of calls).
    // Rows are tiny, so an occasional sweep is enough; errors are ignored.
    if (Math.random() < 0.02) {
      void prisma.rateLimitEntry
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((cleanupError) => {
          console.error("[rateLimit] cleanup error (ignored)", cleanupError);
        });
    }

    if (entry.count > limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
  } catch (error) {
    if (failClosed) {
      console.error("[rateLimit] store error, failing closed", error);
      return { allowed: false, retryAfterSeconds: 60 };
    }
    console.error("[rateLimit] store error, failing open", error);
    return { allowed: true };
  }
}
