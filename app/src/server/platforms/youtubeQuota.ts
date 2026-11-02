import { consumeFixedWindow, exhaustFixedWindow } from "@/lib/rateLimit";

import { nextPacificMidnight, pacificDayKey } from "./rateLimited";

// 2026-11-01 scale audit (platform limits): YouTube `videos.insert` has its own
// bucket, separate from the general 10,000-unit quota, and it resets at midnight
// Pacific Time. Counting our own uploads lets a job defer to the reset instead
// of spending an upload (and a download of the video) that Google will refuse.

/**
 * Default `videos.insert` calls per day: "videos.insert has its own bucket of
 * 100 calls/day". Source: https://developers.google.com/youtube/v3/determine_quota_cost
 * Override with YOUTUBE_DAILY_UPLOAD_LIMIT (an approved quota extension raises it).
 */
export const DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT = 100;

const YOUTUBE_DAILY_UPLOAD_LIMIT_ENV = "YOUTUBE_DAILY_UPLOAD_LIMIT";

/**
 * Uploads allowed per Pacific day: an integer >= 0 from YOUTUBE_DAILY_UPLOAD_LIMIT.
 * A missing or invalid value gives the default; `0` disables YouTube uploads.
 */
export function youtubeDailyUploadLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[YOUTUBE_DAILY_UPLOAD_LIMIT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) ? limit : DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT;
}

/** One counter per Pacific day, so it rolls over exactly when Google's quota does. */
function uploadKey(now: Date): string {
  return `quota:youtube:videos.insert:${pacificDayKey(now)}`;
}

/**
 * Take one of today's `videos.insert` slots. Denied once the day's budget is
 * used up, with the instant the budget resets (the next midnight Pacific).
 *
 * A store error fails OPEN, like the limiter it is built on: Google's own 403
 * is classified anyway (rateLimited.ts), so a counter outage cannot block
 * publishing. A limit of 0 is decided here and never touches the store, so the
 * switch holds even when the store is down.
 */
export async function consumeYouTubeUploadSlot(
  now: Date = new Date(),
): Promise<{ allowed: true } | { allowed: false; resetAt: Date }> {
  const resetAt = nextPacificMidnight(now);
  const limit = youtubeDailyUploadLimit();
  if (limit === 0) return { allowed: false, resetAt };

  const result = await consumeFixedWindow({ key: uploadKey(now), limit, resetAt });
  return result.allowed ? { allowed: true } : { allowed: false, resetAt };
}

/**
 * Google said the quota is gone (`quotaExceeded`): mark today's budget used up
 * so the other jobs defer to the reset without each spending a failed upload.
 * Store errors are swallowed.
 */
export async function exhaustYouTubeUploadBudget(now: Date = new Date()): Promise<void> {
  await exhaustFixedWindow({
    key: uploadKey(now),
    limit: youtubeDailyUploadLimit(),
    resetAt: nextPacificMidnight(now),
  });
}
