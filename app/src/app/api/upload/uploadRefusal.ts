import { UPLOAD_PATH_REFUSED_MESSAGE } from "@/lib/blobKey";
import { prisma } from "@/lib/db";

/**
 * Why a person's last upload token was refused, kept for 10 minutes.
 * `upload()` from @vercel/blob/client drops a refused token's body, so the page
 * asks GET /api/upload afterwards (lib/uploadFailure.ts); without this it could
 * only say "wait a few minutes", which is wrong for a page that is out of date
 * (one opened before uploads declared their size) or a used-up day.
 *
 * One RateLimitEntry row per person (no schema change): `count` holds the
 * reason's number and `expiresAt` the end of the 10 minutes, so the expired-row
 * clean-up in lib/rateLimit.ts removes it. A signed token clears it.
 */
export const UPLOAD_REFUSAL_MEMORY_MS = 10 * 60 * 1000;

export const UPLOAD_PAGE_OUT_OF_DATE_MESSAGE = UPLOAD_PATH_REFUSED_MESSAGE;
export const UPLOAD_DAY_LIMIT_MESSAGE = "You've uploaded 20 GB today. Uploads start again at midnight UTC.";

export type UploadRefusalReason = "out-of-date" | "day-limit" | "empty" | "too-large";

const REASONS: Record<UploadRefusalReason, { number: number; error: string; code: string }> = {
  "out-of-date": { number: 1, error: UPLOAD_PAGE_OUT_OF_DATE_MESSAGE, code: "UPLOAD_PAGE_OUT_OF_DATE" },
  "day-limit": { number: 2, error: UPLOAD_DAY_LIMIT_MESSAGE, code: "UPLOAD_DAY_LIMIT" },
  empty: { number: 3, error: "This file is empty.", code: "UPLOAD_FILE_EMPTY" },
  "too-large": { number: 4, error: "File is too large (max 512 MB).", code: "UPLOAD_FILE_TOO_LARGE" },
};

function refusalKey(userId: string): string {
  return `${userId}:upload/refusal`;
}

/** Remember why this person's token was refused. Never throws: at worst the page says "wait". */
export async function recordUploadRefusal(
  userId: string,
  reason: UploadRefusalReason,
  now: number = Date.now(),
): Promise<void> {
  const key = refusalKey(userId);
  const count = REASONS[reason].number;
  const expiresAt = new Date(now + UPLOAD_REFUSAL_MEMORY_MS);
  try {
    await prisma.rateLimitEntry.upsert({
      where: { key },
      create: { key, count, expiresAt },
      update: { count, expiresAt },
    });
  } catch (error) {
    console.error("[upload] Couldn't remember why an upload was refused (ignored)", error);
  }
}

/** The sentence for this person's refusal in the last 10 minutes, or null. Never throws. */
export async function readUploadRefusal(
  userId: string,
  now: number = Date.now(),
): Promise<{ error: string; code: string } | null> {
  try {
    const row = await prisma.rateLimitEntry.findUnique({ where: { key: refusalKey(userId) } });
    if (!row || new Date(row.expiresAt).getTime() <= now) return null;
    const reason = Object.values(REASONS).find((entry) => entry.number === row.count);
    return reason ? { error: reason.error, code: reason.code } : null;
  } catch (error) {
    console.error("[upload] Couldn't read why an upload was refused (ignored)", error);
    return null;
  }
}

/** Forget it once a token is signed, so a later failure is not blamed on it. Never throws. */
export async function clearUploadRefusal(userId: string): Promise<void> {
  try {
    await prisma.rateLimitEntry.deleteMany({ where: { key: refusalKey(userId) } });
  } catch (error) {
    console.error("[upload] Couldn't clear an upload refusal (ignored)", error);
  }
}
