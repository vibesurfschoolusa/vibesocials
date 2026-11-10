import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";
import {
  DAILY_POST_LIMIT_CODE,
  dailyPostLimitMessage,
  pacificDayRange,
  resolveWorkspaceLimits,
  STORAGE_FULL_CODE,
  storageFullMessage,
  utcDayKey,
  utcDayRange,
  utcMonthKey,
  utcMonthRange,
  X_MONTHLY_LIMIT_CODE,
  xMonthlyLimitMessage,
  YOUTUBE_WORKSPACE_DAILY_LIMIT_CODE,
  youtubeWorkspaceDailyLimitMessage,
  type DailyPostLimitMode,
  type UsageLimitKind,
  type WorkspaceLimits,
} from "@/lib/usageLimits";
import { pacificDayKey } from "@/server/platforms/rateLimited";
import { buildLimitReachedEmail } from "@/server/notifications/limitReachedEmail";
import { sendEmail } from "@/server/notifications/email";

/**
 * Per-workspace usage limits (2026-11-10): the counts behind them, one check per
 * limit for the routes and the publish step, and the once-per-window email to
 * the owners. The numbers, windows and sentences are in src/lib/usageLimits.ts.
 *
 * Every check FAILS OPEN: if a count cannot be read it logs and allows, like the
 * rate limiter, so a database blip never stops publishing. A count followed by
 * a write can let two simultaneous requests through; that is accepted.
 */

/** What a route returns, as `{ error, code }`, when a limit refuses a request. */
export type LimitRefusal = { error: string; code: string };

/** What the publish step writes on the result when a limit refuses a platform. */
export type ResultLimitRefusal = { errorCode: string; errorMessage: string };

export type UsageMeter = { used: number; limit: number; resetsAt: Date | null };

export type WorkspaceUsage = {
  postsToday: UsageMeter;
  xPostsThisMonth: UsageMeter;
  youtubeUploadsToday: UsageMeter;
  /** Bytes. */
  storage: UsageMeter;
};

async function loadWorkspace(workspaceId: string): Promise<{ name: string; limits: WorkspaceLimits }> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      limitPostsPerDay: true,
      limitXPostsPerMonth: true,
      limitYoutubeUploadsPerDay: true,
      limitStorageMb: true,
    },
  });
  return { name: row?.name ?? "Your workspace", limits: resolveWorkspaceLimits(row ?? {}) };
}

export async function getWorkspaceLimits(workspaceId: string): Promise<WorkspaceLimits> {
  return (await loadWorkspace(workspaceId)).limits;
}

/** Posts counting toward the UTC day of `day`: by scheduledFor, else by createdAt. */
function countPostsOnUtcDay(workspaceId: string, day: Date, excludePostJobId?: string): Promise<number> {
  const { start, end } = utcDayRange(day);
  return prisma.postJob.count({
    where: {
      workspaceId,
      status: { notIn: ["draft", "cancelled"] },
      ...(excludePostJobId ? { id: { not: excludePostJobId } } : {}),
      OR: [
        { scheduledFor: { gte: start, lt: end } },
        { scheduledFor: null, createdAt: { gte: start, lt: end } },
      ],
    },
  });
}

function countXPostsThisMonth(workspaceId: string, now: Date): Promise<number> {
  return prisma.postJobResult.count({
    where: {
      workspaceId,
      platform: "x",
      status: "success",
      updatedAt: { gte: utcMonthRange(now).start },
    },
  });
}

function countYoutubeUploadsToday(workspaceId: string, now: Date): Promise<number> {
  const { start, end } = pacificDayRange(now);
  return prisma.postJobResult.count({
    where: {
      workspaceId,
      platform: "youtube",
      status: "success",
      updatedAt: { gte: start, lt: end },
    },
  });
}

async function storageBytesUsed(workspaceId: string): Promise<number> {
  const sum = await prisma.mediaItem.aggregate({
    where: { workspaceId, deletedAt: null },
    _sum: { sizeBytes: true },
  });
  return sum._sum.sizeBytes ?? 0;
}

/**
 * Email every owner the first time `kind` is hit in its window. A limit-1
 * counter per window decides "first time"; the per-owner idempotency key stops
 * a repeat send if the counter store is down (it fails open). Best-effort: never
 * throws, so it can run inside a route or a publish step that may repeat.
 */
async function notifyOwnersOfLimitReached(args: {
  workspaceId: string;
  workspaceName: string;
  kind: UsageLimitKind;
  limit: number;
  windowKey: string;
  windowEnd: Date;
  /** When the limit starts again, as the email says it; null for storage. */
  resetsAt: Date | null;
}): Promise<void> {
  const { workspaceId, kind, windowKey } = args;
  try {
    const first = await consumeFixedWindow({
      key: `usage-limit-email:${workspaceId}:${kind}:${windowKey}`,
      limit: 1,
      resetAt: args.windowEnd,
    });
    if (!first.allowed) return;

    const owners = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
    const email = buildLimitReachedEmail({
      workspaceName: args.workspaceName,
      kind,
      limit: args.limit,
      resetsAt: args.resetsAt,
    });
    for (const owner of owners) {
      await sendEmail(
        { to: owner.user.email, ...email },
        { idempotencyKey: `usage-limit/${workspaceId}/${kind}/${windowKey}/${owner.user.id}` },
      );
    }
  } catch (error) {
    logger.error("[usage] Couldn't email the owners about a reached limit (ignored)", {
      error,
      workspaceId,
      kind,
    });
  }
}

/**
 * Refuse a post committed to the UTC day of `day` when that day already has the
 * workspace's limit of posts. `excludePostJobId` is the post being moved or
 * published, which must not count against itself.
 */
export async function checkDailyPostLimit(args: {
  workspaceId: string;
  day: Date;
  mode: DailyPostLimitMode;
  excludePostJobId?: string;
}): Promise<LimitRefusal | null> {
  const { workspaceId, day, mode, excludePostJobId } = args;
  try {
    const { name, limits } = await loadWorkspace(workspaceId);
    const used = await countPostsOnUtcDay(workspaceId, day, excludePostJobId);
    if (used < limits.postsPerDay) return null;

    const { end } = utcDayRange(day);
    await notifyOwnersOfLimitReached({
      workspaceId,
      workspaceName: name,
      kind: "postsPerDay",
      limit: limits.postsPerDay,
      windowKey: utcDayKey(day),
      windowEnd: end,
      resetsAt: end,
    });
    return { error: dailyPostLimitMessage(limits.postsPerDay, mode), code: DAILY_POST_LIMIT_CODE };
  } catch (error) {
    logger.error("[usage] Daily post limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/** Refuse an X publish once the workspace's X posts this UTC month reach its limit. */
export async function checkXMonthlyLimit(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ResultLimitRefusal | null> {
  try {
    const { name, limits } = await loadWorkspace(workspaceId);
    const used = await countXPostsThisMonth(workspaceId, now);
    if (used < limits.xPostsPerMonth) return null;

    const { end } = utcMonthRange(now);
    await notifyOwnersOfLimitReached({
      workspaceId,
      workspaceName: name,
      kind: "xPostsPerMonth",
      limit: limits.xPostsPerMonth,
      windowKey: utcMonthKey(now),
      windowEnd: end,
      resetsAt: end,
    });
    return { errorCode: X_MONTHLY_LIMIT_CODE, errorMessage: xMonthlyLimitMessage(limits.xPostsPerMonth, now) };
  } catch (error) {
    logger.error("[usage] X monthly limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/** Refuse a YouTube upload once the workspace's uploads this Pacific day reach its limit. */
export async function checkYoutubeDailyLimit(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ResultLimitRefusal | null> {
  try {
    const { name, limits } = await loadWorkspace(workspaceId);
    const used = await countYoutubeUploadsToday(workspaceId, now);
    if (used < limits.youtubeUploadsPerDay) return null;

    const { end } = pacificDayRange(now);
    await notifyOwnersOfLimitReached({
      workspaceId,
      workspaceName: name,
      kind: "youtubeUploadsPerDay",
      limit: limits.youtubeUploadsPerDay,
      windowKey: pacificDayKey(now),
      windowEnd: end,
      resetsAt: end,
    });
    return {
      errorCode: YOUTUBE_WORKSPACE_DAILY_LIMIT_CODE,
      errorMessage: youtubeWorkspaceDailyLimitMessage(limits.youtubeUploadsPerDay),
    };
  } catch (error) {
    logger.error("[usage] YouTube daily limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/**
 * Refuse a new upload once the workspace's media is at or over its storage
 * limit. Checked before the upload, so one file can take it over; that is accepted.
 */
export async function checkStorageLimit(
  workspaceId: string,
  now: Date = new Date(),
): Promise<LimitRefusal | null> {
  try {
    const { name, limits } = await loadWorkspace(workspaceId);
    const used = await storageBytesUsed(workspaceId);
    if (used < limits.storageBytes) return null;

    await notifyOwnersOfLimitReached({
      workspaceId,
      workspaceName: name,
      kind: "storage",
      limit: limits.storageBytes,
      // Storage has no window of its own: the owners hear about it once per UTC day.
      windowKey: utcDayKey(now),
      windowEnd: utcDayRange(now).end,
      resetsAt: null,
    });
    return { error: storageFullMessage(limits.storageBytes), code: STORAGE_FULL_CODE };
  } catch (error) {
    logger.error("[usage] Storage limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/** Used and limit for all four, for Settings. Throws on a database error (the page's own error handling applies). */
export async function getWorkspaceUsage(workspaceId: string, now: Date): Promise<WorkspaceUsage> {
  const [limits, postsToday, xPosts, youtubeUploads, storage] = await Promise.all([
    getWorkspaceLimits(workspaceId),
    countPostsOnUtcDay(workspaceId, now),
    countXPostsThisMonth(workspaceId, now),
    countYoutubeUploadsToday(workspaceId, now),
    storageBytesUsed(workspaceId),
  ]);
  return {
    postsToday: { used: postsToday, limit: limits.postsPerDay, resetsAt: utcDayRange(now).end },
    xPostsThisMonth: { used: xPosts, limit: limits.xPostsPerMonth, resetsAt: utcMonthRange(now).end },
    youtubeUploadsToday: {
      used: youtubeUploads,
      limit: limits.youtubeUploadsPerDay,
      resetsAt: pacificDayRange(now).end,
    },
    storage: { used: storage, limit: limits.storageBytes, resetsAt: null },
  };
}
