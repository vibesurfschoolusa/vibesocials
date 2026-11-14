import { prisma } from "@/lib/db";
import { UPLOAD_LINK_BYTES_PER_DAY } from "@/lib/uploadLink";
import type { RateLimitResult } from "@/lib/rateLimit";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The row's count is a 32-bit Int, so bytes are counted in KiB (20 GB fits easily). */
const LIMIT_KIB = UPLOAD_LINK_BYTES_PER_DAY / 1024;

/**
 * Count `bytes` against the link's UTC day (F5). The same RateLimitEntry row
 * kind as lib/rateLimit.ts, with the count raised by the file's size instead of
 * by one. A refused file gives its share back, so a smaller one still fits.
 * Fails closed: the route is public and each token can write 512 MB.
 */
export async function consumeUploadLinkDayBytes(
  linkId: string,
  bytes: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const bucket = Math.floor(now / DAY_MS);
  const key = `upload-link:${linkId}:upload-link/bytes-day:${bucket}`;
  const resetAt = new Date((bucket + 1) * DAY_MS);
  const kib = Math.max(1, Math.ceil(bytes / 1024));
  try {
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: kib, expiresAt: resetAt },
      update: { count: { increment: kib } },
    });
    if (entry.count <= LIMIT_KIB) return { allowed: true };
    await prisma.rateLimitEntry
      .update({ where: { key }, data: { count: { decrement: kib } } })
      .catch((error: unknown) => console.error("[upload-link] Couldn't give back refused bytes (ignored)", error));
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)) };
  } catch (error) {
    console.error("[upload-link] Byte counter store error, failing closed", error);
    return { allowed: false, retryAfterSeconds: 60 };
  }
}
