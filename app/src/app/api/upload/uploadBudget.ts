import { prisma } from "@/lib/db";
import { MAX_MEDIA_BYTES } from "@/lib/mediaInput";
import type { RateLimitResult } from "@/lib/rateLimit";

import { UPLOAD_DAY_LIMIT_MESSAGE, UPLOAD_PAGE_OUT_OF_DATE_MESSAGE, type UploadRefusalReason } from "./uploadRefusal";

/**
 * R2 M1: the bytes one signed-in person may ask upload tokens for in a UTC day.
 * The 120-tokens-per-15-minutes limit alone lets one account write about
 * 245 GB an hour, much of it never registered and so never counted. The size
 * a page declares is signed into the token as its maximum (route.ts), so the
 * count below is an upper bound on what was really stored.
 */
export const UPLOAD_BYTES_PER_DAY = 20 * 1024 * 1024 * 1024;

/** A page that sends no size was opened before sizes were sent: it needs a reload. */
export const UPLOAD_SIZE_MISSING_MESSAGE = UPLOAD_PAGE_OUT_OF_DATE_MESSAGE;
export const UPLOAD_EMPTY_MESSAGE = "This file is empty.";
export const UPLOAD_TOO_LARGE_MESSAGE = "File is too large (max 512 MB).";
export const UPLOAD_BYTES_LIMIT_MESSAGE = UPLOAD_DAY_LIMIT_MESSAGE;
/** The byte counter could not be reached; nothing is used up. */
export const UPLOAD_COUNTER_UNAVAILABLE_MESSAGE = "Uploads aren't available right now. Try again in a minute.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The row's count is a 32-bit Int, so bytes are counted in KiB (20 GB fits easily). */
const LIMIT_KIB = UPLOAD_BYTES_PER_DAY / 1024;

function dayKey(userId: string, now: number): { key: string; resetAt: Date } {
  const bucket = Math.floor(now / DAY_MS);
  return { key: `${userId}:upload/bytes-day:${bucket}`, resetAt: new Date((bucket + 1) * DAY_MS) };
}

function toKib(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1024));
}

/** The file size the page sent as the token request's clientPayload (lib/blobKey.ts uploadSizePayload). */
export function declaredUploadSize(
  clientPayload: unknown,
): { ok: true; size: number } | { ok: false; error: string; reason: UploadRefusalReason } {
  let size: unknown;
  try {
    const parsed: unknown = typeof clientPayload === "string" ? JSON.parse(clientPayload) : null;
    size = typeof parsed === "object" && parsed !== null ? (parsed as { size?: unknown }).size : undefined;
  } catch {
    size = undefined;
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, error: UPLOAD_SIZE_MISSING_MESSAGE, reason: "out-of-date" };
  }
  if (size === 0) return { ok: false, error: UPLOAD_EMPTY_MESSAGE, reason: "empty" };
  if (size > MAX_MEDIA_BYTES) return { ok: false, error: UPLOAD_TOO_LARGE_MESSAGE, reason: "too-large" };
  return { ok: true, size };
}

/**
 * Count `bytes` against the person's UTC day, as linkBytes.ts does for a link.
 * A refused file gives its share back, so a smaller one still fits. Fails
 * closed: each token can write up to 512 MB.
 */
export async function consumeUploadDayBytes(
  userId: string,
  bytes: number,
  now: number = Date.now(),
): Promise<RateLimitResult & { unavailable?: true }> {
  const { key, resetAt } = dayKey(userId, now);
  const kib = toKib(bytes);
  try {
    const entry = await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count: kib, expiresAt: resetAt },
      update: { count: { increment: kib } },
    });
    if (entry.count <= LIMIT_KIB) return { allowed: true };
    await prisma.rateLimitEntry
      .update({ where: { key }, data: { count: { decrement: kib } } })
      .catch((error: unknown) => console.error("[upload] Couldn't give back refused bytes (ignored)", error));
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)) };
  } catch (error) {
    console.error("[upload] Byte counter store error, failing closed", error);
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }
}

/**
 * Give back what a token request counted when signing then failed, so the
 * refused request leaves the day as it was. Never below zero, never throws.
 */
export async function releaseUploadDayBytes(userId: string, bytes: number, now: number = Date.now()): Promise<void> {
  const { key } = dayKey(userId, now);
  const kib = toKib(bytes);
  try {
    await prisma.rateLimitEntry.updateMany({
      where: { key, count: { gte: kib } },
      data: { count: { decrement: kib } },
    });
  } catch (error) {
    console.error("[upload] Couldn't give back a refused request's bytes (ignored)", error);
  }
}
