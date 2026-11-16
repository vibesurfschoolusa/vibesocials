import { prisma } from "./db";
import { normalizeEmail } from "./email";

/**
 * Log in's per-(address, network) limit. auth.ts counts in it; a password
 * reset empties it (clearLoginLimitForNetwork). The other two login limits
 * stay in auth.ts: nothing clears them.
 */
export const LOGIN_EMAIL_IP_LIMIT = {
  route: "auth/login",
  limit: 10,
  windowMs: 15 * 60 * 1000,
} as const;

/** The limiter's userId for an (address, network) pair. */
export function loginEmailIpUserId(email: string, ip: string): string {
  return `email-ip:${normalizeEmail(email)}|${ip}`;
}

/**
 * R32 new-customer L1: after 10 wrong passwords a person resets theirs, and
 * the new one must work at once from the same network. Only this bucket is
 * emptied: a reset needs the emailed link, so whoever completes one already
 * controls the account, and the per-network and per-address buckets (which
 * limit guessing at other addresses and from many networks) stay as they are.
 * The key is checkRateLimit's `${userId}:${route}:${bucket}` for the current
 * window (loginLimit.test.ts ties the two together). Throws on a store error.
 */
export async function clearLoginLimitForNetwork(email: string, ip: string): Promise<void> {
  const bucket = Math.floor(Date.now() / LOGIN_EMAIL_IP_LIMIT.windowMs);
  const key = `${loginEmailIpUserId(email, ip)}:${LOGIN_EMAIL_IP_LIMIT.route}:${bucket}`;
  await prisma.rateLimitEntry.deleteMany({ where: { key } });
}
