import { UPLOAD_PATH_REFUSED_MESSAGE } from "@/lib/blobKey";
import { prisma } from "@/lib/db";
import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";
import { tooManyTriesSentence } from "@/lib/tooManyTriesText";
import { COVER_IMAGE_RULE } from "@/lib/videoCover";
import {
  MISSING_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";

/**
 * Why a person's last upload token was refused, kept for 10 minutes.
 * `upload()` from @vercel/blob/client drops a refused token's body, so the page
 * asks GET /api/upload afterwards (lib/uploadFailure.ts); without this it could
 * only say "wait a few minutes", which is wrong for a page that is out of date
 * (one opened before uploads declared their size) or a used-up day.
 *
 * One RateLimitEntry row per person (no schema change): `count` holds the
 * reason's number and `expiresAt` the end of the 10 minutes, so the expired-row
 * clean-up in lib/rateLimit.ts removes it. Each token request clears it
 * first (R3-security L1), so it only ever explains the latest refusal.
 */
export const UPLOAD_REFUSAL_MEMORY_MS = 10 * 60 * 1000;

export const UPLOAD_PAGE_OUT_OF_DATE_MESSAGE = UPLOAD_PATH_REFUSED_MESSAGE;
export const UPLOAD_DAY_LIMIT_MESSAGE = "You've uploaded 20 GB today. Uploads start again at midnight UTC.";

export type UploadRefusalReason =
  | "out-of-date"
  | "day-limit"
  | "empty"
  | "too-large"
  | "cover-too-large"
  | "workspace-changed"
  | "workspace-missing"
  | "limit-unchecked"
  | "rate-limited";

const REASONS: Record<UploadRefusalReason, { number: number; error: string; code: string }> = {
  "out-of-date": { number: 1, error: UPLOAD_PAGE_OUT_OF_DATE_MESSAGE, code: "UPLOAD_PAGE_OUT_OF_DATE" },
  "day-limit": { number: 2, error: UPLOAD_DAY_LIMIT_MESSAGE, code: "UPLOAD_DAY_LIMIT" },
  empty: { number: 3, error: "This file is empty.", code: "UPLOAD_FILE_EMPTY" },
  "too-large": { number: 4, error: "File is too large (max 512 MB).", code: "UPLOAD_FILE_TOO_LARGE" },
  "cover-too-large": { number: 5, error: COVER_IMAGE_RULE, code: "UPLOAD_COVER_TOO_LARGE" },
  // R31: the page is for another workspace, or from before the release.
  "workspace-changed": { number: 6, error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE },
  "workspace-missing": { number: 7, error: MISSING_WORKSPACE_ID_MESSAGE, code: MISSING_WORKSPACE_ID_CODE },
  // R38: the upload limit's store couldn't answer (lib/limitUnchecked.ts).
  "limit-unchecked": { number: 8, error: LIMIT_UNCHECKED_MESSAGE, code: "UPLOAD_LIMIT_UNCHECKED" },
  // R44 new-customer L5: the upload token limit. Kept only until the limit's
  // window ends (`until`), and its sentence is built from the wait left then.
  "rate-limited": { number: 9, error: tooManyTriesSentence(undefined), code: "UPLOAD_RATE_LIMITED" },
};

function refusalKey(userId: string): string {
  return `${userId}:upload/refusal`;
}

/**
 * Remember why this person's token was refused. Never throws: at worst the page says "wait".
 * `until`: when the refusal stops being true (a limit's reset), if sooner than
 * the 10 minutes; the remembered wait is then counted down to it.
 */
export async function recordUploadRefusal(
  userId: string,
  reason: UploadRefusalReason,
  now: number = Date.now(),
  until?: Date,
): Promise<void> {
  const key = refusalKey(userId);
  const count = REASONS[reason].number;
  const expiresAt = new Date(
    until ? Math.min(until.getTime(), now + UPLOAD_REFUSAL_MEMORY_MS) : now + UPLOAD_REFUSAL_MEMORY_MS,
  );
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
): Promise<{ error: string; code: string; retryAfterSeconds?: number } | null> {
  try {
    const row = await prisma.rateLimitEntry.findUnique({ where: { key: refusalKey(userId) } });
    if (!row || new Date(row.expiresAt).getTime() <= now) return null;
    if (row.count === REASONS["rate-limited"].number) {
      const retryAfterSeconds = Math.ceil((new Date(row.expiresAt).getTime() - now) / 1000);
      return { error: tooManyTriesSentence(retryAfterSeconds), code: REASONS["rate-limited"].code, retryAfterSeconds };
    }
    const reason = Object.values(REASONS).find((entry) => entry.number === row.count);
    return reason ? { error: reason.error, code: reason.code } : null;
  } catch (error) {
    console.error("[upload] Couldn't read why an upload was refused (ignored)", error);
    return null;
  }
}

/** Forget it at the start of each token request, so a later failure is not blamed on it. Never throws. */
export async function clearUploadRefusal(userId: string): Promise<void> {
  try {
    await prisma.rateLimitEntry.deleteMany({ where: { key: refusalKey(userId) } });
  } catch (error) {
    console.error("[upload] Couldn't clear an upload refusal (ignored)", error);
  }
}
