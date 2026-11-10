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

/**
 * What the publish step writes on the result when a limit refuses a platform,
 * plus the owners' email, which the step sends only after it has recorded the
 * result (bounded, never throws).
 */
export type ResultLimitRefusal = {
  errorCode: string;
  errorMessage: string;
  notifyOwners: () => Promise<void>;
};

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

/**
 * Bytes of the workspace's live media. Summed as bigint in SQL: `sizeBytes` is an
 * Int column and a workspace's total can pass 2,147,483,647, so the result must
 * not depend on how Prisma types an Int sum.
 */
async function storageBytesUsed(workspaceId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: bigint | number | null }[]>`
    SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS "total"
    FROM "MediaItem"
    WHERE "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL`;
  return Number(rows[0]?.total ?? 0);
}

/** How long the owners' email may hold up its caller before the caller carries on. */
const NOTIFY_TIMEOUT_MS = 5_000;

type LimitNotice = {
  workspaceId: string;
  workspaceName: string;
  kind: UsageLimitKind;
  limit: number;
  windowKey: string;
  windowEnd: Date;
  /** When the limit starts again, as the email says it; null when the email names none. */
  resetsAt: Date | null;
  /** Posts per day only: the UTC day that is full. */
  day?: Date;
};

async function sendLimitReachedEmails(args: LimitNotice): Promise<void> {
  const { workspaceId, kind, windowKey } = args;
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
    day: args.day ?? null,
  });
  for (const owner of owners) {
    await sendEmail(
      { to: owner.user.email, ...email },
      { idempotencyKey: `usage-limit/${workspaceId}/${kind}/${windowKey}/${owner.user.id}` },
    );
  }
}

/**
 * Email every owner the first time `kind` is hit in its window. A limit-1
 * counter per window decides "first time"; the per-owner idempotency key stops
 * a repeat send if the counter store is down (it fails open). Best-effort and
 * bounded: it never throws, and after NOTIFY_TIMEOUT_MS the caller carries on
 * (the counter is spent by then, so a cut-off send is not retried: at most once).
 */
async function notifyOwnersOfLimitReached(args: LimitNotice): Promise<void> {
  const { workspaceId, kind } = args;
  const work = sendLimitReachedEmails(args).then(
    () => "sent" as const,
    (error: unknown) => {
      logger.error("[usage] Couldn't email the owners about a reached limit (ignored)", {
        error,
        workspaceId,
        kind,
      });
      return "failed" as const;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), NOTIFY_TIMEOUT_MS);
  });
  try {
    if ((await Promise.race([work, timeout])) === "timeout") {
      logger.error("[usage] Emailing the owners about a reached limit took too long; carrying on", {
        workspaceId,
        kind,
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
    }
  } finally {
    clearTimeout(timer);
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
      resetsAt: null,
      day,
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
    return {
      errorCode: X_MONTHLY_LIMIT_CODE,
      errorMessage: xMonthlyLimitMessage(limits.xPostsPerMonth, now),
      notifyOwners: () =>
        notifyOwnersOfLimitReached({
          workspaceId,
          workspaceName: name,
          kind: "xPostsPerMonth",
          limit: limits.xPostsPerMonth,
          windowKey: utcMonthKey(now),
          windowEnd: end,
          resetsAt: end,
        }),
    };
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
    return {
      errorCode: YOUTUBE_WORKSPACE_DAILY_LIMIT_CODE,
      errorMessage: youtubeWorkspaceDailyLimitMessage(limits.youtubeUploadsPerDay),
      notifyOwners: () =>
        notifyOwnersOfLimitReached({
          workspaceId,
          workspaceName: name,
          kind: "youtubeUploadsPerDay",
          limit: limits.youtubeUploadsPerDay,
          windowKey: pacificDayKey(now),
          windowEnd: end,
          resetsAt: end,
        }),
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

/** Used and limit for all four. Throws on a database error; Settings reads it through getWorkspaceUsageOrNull. */
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

/** For Settings: the usage, or null (logged) when it cannot be read, so the page still renders. */
export async function getWorkspaceUsageOrNull(workspaceId: string, now: Date): Promise<WorkspaceUsage | null> {
  try {
    return await getWorkspaceUsage(workspaceId, now);
  } catch (error) {
    logger.error("[usage] Couldn't read the workspace's usage for Settings", { error, workspaceId });
    return null;
  }
}
