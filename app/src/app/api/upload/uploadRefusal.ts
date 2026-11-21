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
 * Why a person's last upload token was refused, kept for 10 minutes (the
 * token limit's refusal: until the limit resets).
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

const PAST_DAY_LIMIT = "This file would take you past today's 20 GB upload limit.";
const PAST_DAY_LIMIT_UNKNOWN_MESSAGE = `${PAST_DAY_LIMIT} A smaller file may still go today; the limit resets at midnight UTC.`;

/**
 * R62 pages-a-2 L1: the 20 GB refusal, from the bytes the day had left before
 * this file (consumeUploadDayBytes). Under 1 MB left, the day is used up;
 * unknown, a smaller file may still fit.
 */
export function dayLimitRefusalMessage(leftBytes: number | undefined): string {
  if (leftBytes === undefined) return PAST_DAY_LIMIT_UNKNOWN_MESSAGE;
  const leftMb = wholeMbLeft(leftBytes);
  if (leftMb < 1) return UPLOAD_DAY_LIMIT_MESSAGE;
  return pastDayLimitMessage(leftMb);
}

function wholeMbLeft(leftBytes: number): number {
  return Math.floor(leftBytes / (1024 * 1024));
}

function pastDayLimitMessage(leftMb: number): string {
  return `${PAST_DAY_LIMIT} A file under ${leftMb} MB can still go today; the limit resets at midnight UTC.`;
}

/**
 * The row's `count` holds the reason's number; a file past the day's limit
 * stores this plus the whole megabytes that were left, so the page's later
 * question names them too. What is left is under the 512 MB file that did not
 * fit, so it never reaches another reason's number.
 */
const PAST_DAY_LIMIT_BASE = 1000;

export type UploadRefusalReason =
  | "out-of-date"
  | "day-limit"
  | "past-day-limit"
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
  // R62 pages-a-2 L1: only this file doesn't fit. Kept with what was left
  // (PAST_DAY_LIMIT_BASE); this entry is for a refusal without it.
  "past-day-limit": { number: 10, error: PAST_DAY_LIMIT_UNKNOWN_MESSAGE, code: "UPLOAD_DAY_LIMIT" },
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
 * `until`: when the refusal stops being true (a limit's reset). It is kept
 * until then, with no 10-minute cap: the upload limit's fixed 15-minute block
 * can leave up to 900 s, and a shorter memory would name too short a wait
 * (R44 review). The remembered wait is counted down to it. A reason with no
 * reset keeps the 10 minutes.
 */
export async function recordUploadRefusal(
  userId: string,
  reason: UploadRefusalReason,
  now: number = Date.now(),
  until?: Date,
): Promise<void> {
  await writeRefusal(userId, REASONS[reason].number, until ?? new Date(now + UPLOAD_REFUSAL_MEMORY_MS));
}

/**
 * Remember a refusal at the day's 20 GB with what the day had left before
 * this file, so the page's sentence is dayLimitRefusalMessage's. Never throws.
 */
export async function recordDayLimitRefusal(
  userId: string,
  leftBytes: number | undefined,
  now: number = Date.now(),
): Promise<void> {
  const expiresAt = new Date(now + UPLOAD_REFUSAL_MEMORY_MS);
  if (leftBytes === undefined) return writeRefusal(userId, REASONS["past-day-limit"].number, expiresAt);
  const leftMb = wholeMbLeft(leftBytes);
  if (leftMb < 1) return writeRefusal(userId, REASONS["day-limit"].number, expiresAt);
  return writeRefusal(userId, PAST_DAY_LIMIT_BASE + leftMb, expiresAt);
}

async function writeRefusal(userId: string, count: number, expiresAt: Date): Promise<void> {
  const key = refusalKey(userId);
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

/** The sentence for this person's refusal while it is remembered, or null. Never throws. */
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
    if (row.count > PAST_DAY_LIMIT_BASE) {
      return { error: pastDayLimitMessage(row.count - PAST_DAY_LIMIT_BASE), code: REASONS["past-day-limit"].code };
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
