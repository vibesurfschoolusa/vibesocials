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
  /**
   * R32 (Log in): with failClosed, mark a denial caused by a store error with
   * `unavailable: true`, so the caller can tell it from a used-up limit.
   * Opt-in, so every other caller's answers stay exactly as they were.
   */
  markUnavailable?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (only set when blocked). */
  retryAfterSeconds?: number;
  /** Only with markUnavailable: the store failed, so nothing was counted or checked. */
  unavailable?: true;
}

/** Options of {@link consumeFixedWindow}: one explicit window, no bucketing. */
export interface ConsumeFixedWindowOptions {
  /** The full counter key. The caller owns its shape (and its window id). */
  key: string;
  /** Maximum number of allowed consumptions while the row lives. */
  limit: number;
  /** When the row (and so the window) expires. */
  resetAt: Date;
  /** Same meaning as {@link CheckRateLimitOptions.failClosed}. */
  failClosed?: boolean;
  /** Same meaning as {@link CheckRateLimitOptions.markUnavailable}. */
  markUnavailable?: boolean;
}

/**
 * Atomically count one use of `key` and say whether it is still within `limit`.
 *
 * The shared core of {@link checkRateLimit} (a window bucketed by time) and of
 * counters whose window is not a fixed length, such as the YouTube daily upload
 * budget that resets at midnight Pacific (youtubeQuota.ts). Factored out in the
 * 2026-11-01 scale audit (platform limits); checkRateLimit's contract is
 * unchanged. Atomicity comes from a single DB upsert.
 *
 * Default Fails OPEN: any store error — including "table does not exist"
 * before the migration is applied — is logged loudly and the request is
 * allowed, so the limiter never takes a product route down. Pass
 * `failClosed: true` for anonymous auth routes.
 */
export async function consumeFixedWindow(
  opts: ConsumeFixedWindowOptions,
): Promise<RateLimitResult> {
  const { key, limit, resetAt, failClosed = false, markUnavailable = false } = opts;
  const now = Date.now();

  try {
    // Atomic per-key increment; the DB serializes concurrent upserts.
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: resetAt },
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
        Math.ceil((resetAt.getTime() - now) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
  } catch (error) {
    if (failClosed) {
      console.error("[rateLimit] store error, failing closed", error);
      return markUnavailable ? { allowed: false, retryAfterSeconds: 60, unavailable: true } : { allowed: false, retryAfterSeconds: 60 };
    }
    console.error("[rateLimit] store error, failing open", error);
    return { allowed: true };
  }
}

/**
 * Mark the window of `key` as used up: upsert its count straight to `limit`, so
 * the next {@link consumeFixedWindow} on it is denied. Used when the platform
 * itself says the budget is gone (e.g. YouTube `quotaExceeded`) while our own
 * count is lower. Logs and swallows a store error: an exhausted marker is an
 * optimization, and the platform's own refusal still applies without it.
 */
export async function exhaustFixedWindow(opts: {
  key: string;
  limit: number;
  resetAt: Date;
}): Promise<void> {
  const { key, limit, resetAt } = opts;
  try {
    await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: limit, expiresAt: resetAt },
      update: { count: limit },
    });
  } catch (error) {
    console.error("[rateLimit] store error while exhausting a window (ignored)", error);
  }
}

/**
 * DB-backed fixed-window rate limiter.
 *
 * Buckets time into `windowMs` slices and counts requests per
 * `userId:route:bucket` key in Postgres, so the limit holds across all
 * serverless instances (an in-memory counter would multiply with horizontal
 * scale). The counting itself is {@link consumeFixedWindow}.
 *
 * Default Fails OPEN: any store error — including "table does not exist"
 * before the migration is applied — is logged loudly and the request is
 * allowed, so the limiter never takes a product route down. Pass
 * `failClosed: true` for anonymous auth routes.
 */
export async function checkRateLimit(
  opts: CheckRateLimitOptions,
): Promise<RateLimitResult> {
  const { userId, route, limit, windowMs, failClosed = false, markUnavailable = false } = opts;

  const { key, resetAt } = rateLimitWindow(userId, route, windowMs);

  return consumeFixedWindow({ key, limit, resetAt, failClosed, markUnavailable });
}

/** checkRateLimit's counter key and window end for `userId` + `route` right now. */
export function rateLimitWindow(userId: string, route: string, windowMs: number): { key: string; resetAt: Date } {
  const bucket = Math.floor(Date.now() / windowMs);
  return { key: `${userId}:${route}:${bucket}`, resetAt: new Date((bucket + 1) * windowMs) };
}

/**
 * R32 lead review: reads a checkRateLimit window without counting a use, and
 * says whether the next use would be refused. Log in reads its other limits
 * this way after one refuses, to state the longest wait. Throws on a store
 * error, so the caller can say it couldn't tell.
 */
export async function peekRateLimit(
  opts: Pick<CheckRateLimitOptions, "userId" | "route" | "limit" | "windowMs">,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> {
  const { key, resetAt } = rateLimitWindow(opts.userId, opts.route, opts.windowMs);
  const entry = await prisma.rateLimitEntry.findUnique({ where: { key } });
  if (!entry || entry.count < opts.limit) return { blocked: false };
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) };
}
