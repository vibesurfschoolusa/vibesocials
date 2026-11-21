import { prisma } from "@/lib/db";
import { UPLOAD_LINK_BYTES_PER_DAY } from "@/lib/uploadLink";
import type { RateLimitResult } from "@/lib/rateLimit";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The row's count is a 32-bit Int, so bytes are counted in KiB (20 GB fits easily). */
const LIMIT_KIB = UPLOAD_LINK_BYTES_PER_DAY / 1024;

/**
 * Count `bytes` against the link's UTC day (F5). The same RateLimitEntry row
 * kind as lib/rateLimit.ts, with the count raised by the file's size instead of
 * by one. A refused file gives its share back, so a smaller one still fits,
 * and `leftBytes` says how much did (R62 pages-a-2 L1). Fails closed: the
 * route is public and each token can write 512 MB.
 */
export async function consumeUploadLinkDayBytes(
  linkId: string,
  bytes: number,
  now: number = Date.now(),
): Promise<RateLimitResult & { leftBytes?: number }> {
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
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
      leftBytes: Math.max(0, LIMIT_KIB - (entry.count - kib)) * 1024,
    };
  } catch (error) {
    console.error("[upload-link] Byte counter store error, failing closed", error);
    // R39 client-journey L1: marked, so the route says "couldn't check", never "20 GB used".
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }
}

/**
 * Give back what a token request counted when a later check refuses it (the
 * storage is full, storage would not sign), so a refused request leaves the
 * link's day as it was. The file is the one checkRateLimit counted under
 * `upload-link:<id>` / "upload-link/upload-day" (its key is
 * `<userId>:<route>:<day bucket>`, lib/rateLimit.ts). Never below zero, never
 * throws: at worst the link's day is a little shorter.
 */
export async function releaseUploadLinkReservation(
  linkId: string,
  reserved: { file: boolean; bytes: number },
  now: number = Date.now(),
): Promise<void> {
  const bucket = Math.floor(now / DAY_MS);
  const releases: Promise<unknown>[] = [];
  if (reserved.file) {
    releases.push(
      prisma.rateLimitEntry.updateMany({
        where: { key: `upload-link:${linkId}:upload-link/upload-day:${bucket}`, count: { gt: 0 } },
        data: { count: { decrement: 1 } },
      }),
    );
  }
  if (reserved.bytes > 0) {
    const kib = Math.max(1, Math.ceil(reserved.bytes / 1024));
    releases.push(
      prisma.rateLimitEntry.updateMany({
        where: { key: `upload-link:${linkId}:upload-link/bytes-day:${bucket}`, count: { gte: kib } },
        data: { count: { decrement: kib } },
      }),
    );
  }
  try {
    await Promise.all(releases);
  } catch (error) {
    console.error("[upload-link] Couldn't give back a refused request's count (ignored)", error);
  }
}
