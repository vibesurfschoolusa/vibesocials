import { planSectionActions } from "@/components/planSectionView";
import {
  BILLING_FIELDS_SELECT,
  billingEnabled,
  billingFieldsSelect,
  offeredPlans,
  type BillingEnv,
  type BillingFields,
} from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PLANS, type PlanLimits } from "@/lib/plans";
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
  type WorkspaceLimitOverrides,
  type WorkspaceLimits,
  type LimitSteps,
} from "@/lib/usageLimits";
import { deferredPostCanSend } from "@/server/jobs/posting";
import { pacificDayKey } from "@/server/platforms/rateLimited";
import { buildLimitReachedEmail } from "@/server/notifications/limitReachedEmail";
import { sendEmail } from "@/server/notifications/email";
import { sendOncePer, sendToEach } from "@/server/notifications/onceADay";

import {
  crossWorkspacePostRefusal,
  ownersPersonalUsage,
  postsOnUtcDayWhere,
  xPostsThisMonth,
  type PersonalUsage,
} from "./usageLog";

export type { PersonalUsage } from "./usageLog";

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
  /**
   * R8-pages M1 and review of T1, item 4: for an owner reading it, each
   * owner's per-person count today across all their free workspaces (theirs
   * and their co-owners'), the number that binds. Absent for anyone else, and
   * where the per-person limit does not apply.
   */
  people?: PersonalUsage[];
  /**
   * For a member (or no known reader): only how many posts this workspace can
   * still send today and which limit decides it, with no owner's details.
   * Absent where the per-person limit does not apply.
   */
  stillToday?: StillToday;
};

/** What a member sees: posts this workspace can still send today, and whether its own limit or an owner's decides. */
export type StillToday = { remaining: number; decidedBy: "workspace" | "owner"; coOwned: boolean };

/** The fewer of what the workspace's own limit and its most-used owner's number leave. */
function stillToday(postsToday: UsageMeter, people: readonly PersonalUsage[]): StillToday {
  const workspaceLeft = Math.max(0, postsToday.limit - postsToday.used);
  const ownerLeft = Math.max(0, Math.min(...people.map((person) => person.limit - person.used)));
  return ownerLeft < workspaceLeft
    ? { remaining: ownerLeft, decidedBy: "owner", coOwned: people.length > 1 }
    : { remaining: workspaceLeft, decidedBy: "workspace", coOwned: people.length > 1 };
}

async function loadWorkspace(
  workspaceId: string,
): Promise<{ name: string; limits: WorkspaceLimits; billing: BillingFields }> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      limitPostsPerDay: true,
      limitXPostsPerMonth: true,
      limitYoutubeUploadsPerDay: true,
      limitStorageMb: true,
      // 21a: the plan columns, only with billing on (the query is today's with it off).
      ...billingFieldsSelect(),
    },
  });
  return { name: row?.name ?? "Your workspace", limits: resolveWorkspaceLimits(row ?? {}), billing: row ?? {} };
}

export async function getWorkspaceLimits(workspaceId: string): Promise<WorkspaceLimits> {
  return (await loadWorkspace(workspaceId)).limits;
}

/** Posts counting toward the UTC day of `day`: by scheduledFor, else by createdAt. */
function countPostsOnUtcDay(
  workspaceId: string,
  day: Date,
  excludePostJobId?: string | readonly string[],
): Promise<number> {
  return prisma.postJob.count({ where: { workspaceId, ...postsOnUtcDayWhere(day, excludePostJobId) } });
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
  /**
   * R40 security L1: when the window's email could first be sent (sendOncePer's
   * keysFrom); null when there is no bound.
   */
  windowStart: Date | null;
  /** When the limit starts again, as the email says it; null when the email names none. */
  resetsAt: Date | null;
  /** Posts per day only: the UTC day that is full. */
  day?: Date;
};

/** The Workspace columns an operator sets to fix a limit, for a select. */
export const LIMIT_OVERRIDES_SELECT = {
  limitPostsPerDay: true,
  limitXPostsPerMonth: true,
  limitYoutubeUploadsPerDay: true,
  limitStorageMb: true,
} as const;

const LIMIT_KINDS: readonly UsageLimitKind[] = ["postsPerDay", "xPostsPerMonth", "youtubeUploadsPerDay", "storage"];

const OVERRIDE_COLUMN = {
  postsPerDay: "limitPostsPerDay",
  xPostsPerMonth: "limitXPostsPerMonth",
  youtubeUploadsPerDay: "limitYoutubeUploadsPerDay",
  storage: "limitStorageMb",
} as const satisfies Record<UsageLimitKind, keyof WorkspaceLimitOverrides>;

/** A limit's number in one unit for both sides: storage in bytes. */
function limitNumber(limits: WorkspaceLimits, kind: UsageLimitKind): number {
  return kind === "storage" ? limits.storageBytes : limits[kind];
}

function planLimitNumber(limits: PlanLimits, kind: UsageLimitKind): number {
  return kind === "storage" ? limits.storageMb * 1024 * 1024 : limits[kind];
}

export type PlanChangeWorkspace = BillingFields & WorkspaceLimitOverrides & { stripeCustomerId?: string | null };

/**
 * Whether changing the plan gives `kind` a higher number, the one rule for
 * where a higher limit comes from: the limit-reached email and Settings' usage
 * line say "change the plan" only when it does, and "write to us" otherwise.
 * All of: billing on; the Plan section offers the owner a plan action (F4,
 * R2-pages L3: never a section with no button); no override column fixes the
 * limit (an operator set it; no plan moves it); and a plan on offer has a
 * higher number than the workspace has now (R43 security L2: Pro, the top
 * plan, was told to change plan too).
 */
export function planChangeRaisesLimit(
  workspace: PlanChangeWorkspace,
  kind: UsageLimitKind,
  now: Date,
  env: BillingEnv = process.env,
): boolean {
  if (!billingEnabled(env)) return false;
  if (planSectionActions("owner", workspace, now, env) === null) return false;
  const override = workspace[OVERRIDE_COLUMN[kind]];
  if (override !== null && override !== undefined) return false;
  const current = limitNumber(resolveWorkspaceLimits(workspace, env, now), kind);
  return offeredPlans(env).some((plan) => planLimitNumber(PLANS[plan].limits, kind) > current);
}

/**
 * Settings' usage line covers every limit at once, so it points to the plan
 * only when a plan change raises each of them; otherwise "write to us", which
 * is true for any limit.
 */
export function planChangeRaisesEveryLimit(
  workspace: PlanChangeWorkspace,
  now: Date,
  env: BillingEnv = process.env,
): boolean {
  return LIMIT_KINDS.every((kind) => planChangeRaisesLimit(workspace, kind, now, env));
}

/** planChangeRaisesLimit for the email, read only once the email is going out. */
async function planInSettingsFor(workspaceId: string, kind: UsageLimitKind): Promise<boolean> {
  if (!billingEnabled()) return false;
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ...BILLING_FIELDS_SELECT, ...LIMIT_OVERRIDES_SELECT, stripeCustomerId: true },
  });
  return row !== null && planChangeRaisesLimit(row, kind, new Date());
}

async function sendLimitReachedEmails(args: LimitNotice): Promise<void> {
  const { workspaceId, kind, windowKey } = args;
  // R39 client-journey L2: through sendOncePer, so the window is let go again
  // when the owners can't be read or no email went, and the next refusal tries.
  await sendOncePer(
    {
      key: `usage-limit-email:${workspaceId}:${kind}:${windowKey}`,
      resetAt: args.windowEnd,
      keysFrom: args.windowStart,
      perRecipientKeys: true,
    },
    async (sendStarted) => {
      const [owners, planInSettings] = await Promise.all([
        prisma.workspaceMember.findMany({
          where: { workspaceId, role: "owner" },
          select: { user: { select: { id: true, email: true, timeZone: true } } },
        }),
        planInSettingsFor(workspaceId, kind),
      ]);
      // A lost reply throws (the window is let go); the next try reuses each key.
      return sendToEach(owners, (owner) => {
        // R2-pages L4: built per owner, so each reads the times in their own zone.
        const email = buildLimitReachedEmail({
          workspaceId,
          workspaceName: args.workspaceName,
          planInSettings,
          appBaseUrl: process.env.NEXTAUTH_URL || null,
          kind,
          limit: args.limit,
          resetsAt: args.resetsAt,
          day: args.day ?? null,
          timeZone: owner.user.timeZone ?? null,
        });
        return sendEmail(
          { to: owner.user.email, ...email },
          { idempotencyKey: `usage-limit/${workspaceId}/${kind}/${windowKey}/${owner.user.id}`, throwOnRetryable: true },
        );
      }, sendStarted);
    },
    (error) =>
      logger.error("[usage] Couldn't email the owners about a reached limit (a later refusal tries again)", {
        error,
        workspaceId,
        kind,
      }),
  );
}

/**
 * Email every owner the first time `kind` is hit in its window, once per
 * window through sendOncePer, with a per-owner idempotency key. Best-effort
 * and bounded: it never throws, and after NOTIFY_TIMEOUT_MS the caller carries
 * on while the send finishes.
 */
async function notifyOwnersOfLimitReached(args: LimitNotice): Promise<void> {
  const { workspaceId, kind } = args;
  const work = sendLimitReachedEmails(args);
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
 * R8-publishing L2: a pair going out now (publish or approve now: `exclude` is
 * this post, then its other half, as pairLimitArgs gives them) is one run per
 * half that has something to send; the other half counts as a run only then.
 * Scheduling counts both: their results are made when they are due.
 */
async function pairRunsAlso(
  mode: DailyPostLimitMode,
  exclude: string | readonly string[] | undefined,
  alsoOnDay: number | undefined,
): Promise<number | undefined> {
  if (mode !== "now" || !Array.isArray(exclude) || exclude.length < 2 || !alsoOnDay) return alsoOnDay;
  const halves = await Promise.all(exclude.slice(1).map((id) => deferredPostCanSend(id)));
  return Math.max(0, alsoOnDay - halves.filter((canSend) => !canSend).length);
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
  /** The post being moved, or both halves of a Feed and Story post: neither counts against itself. */
  excludePostJobId?: string | readonly string[];
  /**
   * Posts of the same request already counted for this UTC day but not stored
   * yet: the earlier posts of a repeating post that fall on the same day.
   */
  alsoOnDay?: number;
  /**
   * R8-publishing L2: of `alsoOnDay`, how many make a run now (Post now's
   * Story only when it can send). The limits across workspaces count runs;
   * the workspace's own limit counts posts, a failed one included.
   */
  runsAlsoOnDay?: number;
  /** Second look, point 1: who reads the refusal, so an owner held back by their own lower number reads "you". */
  viewerUserId?: string;
  /** R55 pages-a-3 L1: whose steps the sentence ends with (the approver's, on an approval card); only the words change. */
  steps?: LimitSteps;
  /** R57 publishing-flow L3: the reader's stored time zone, for the reset in the sentence; only the words change. */
  timeZone?: string | null;
}): Promise<LimitRefusal | null> {
  const { workspaceId, day, mode, excludePostJobId } = args;
  try {
    const { name, limits, billing } = await loadWorkspace(workspaceId);
    const used = (await countPostsOnUtcDay(workspaceId, day, excludePostJobId)) + (args.alsoOnDay ?? 0);
    // R56 publishing-flow L1: the day counted is today (UTC); only the sentence's ending reads it.
    const dayIsToday = utcDayKey(day) === utcDayKey(new Date());
    // R5-security M1: then the limits a person cannot multiply by making
    // workspaces: their own total, and the service's cap. No email: the
    // refusal says what to do.
    if (used < limits.postsPerDay) {
      return await crossWorkspacePostRefusal({
        workspaceId,
        workspace: billing,
        day,
        mode,
        excludePostJobId,
        alsoOnDay: args.runsAlsoOnDay ?? (await pairRunsAlso(mode, excludePostJobId, args.alsoOnDay)),
        viewerUserId: args.viewerUserId,
        ...(args.steps ? { steps: args.steps } : {}),
        ...(dayIsToday ? { dayIsToday } : {}),
        ...(args.timeZone ? { timeZone: args.timeZone } : {}),
      });
    }

    const { end } = utcDayRange(day);
    await notifyOwnersOfLimitReached({
      workspaceId,
      workspaceName: name,
      kind: "postsPerDay",
      limit: limits.postsPerDay,
      windowKey: utcDayKey(day),
      windowEnd: end,
      // A day can be filled while scheduling days ahead, so its email can have gone long before it.
      windowStart: null,
      resetsAt: null,
      day,
    });
    return { error: dailyPostLimitMessage(limits.postsPerDay, mode, { timeZone: args.timeZone }, args.steps, dayIsToday), code: DAILY_POST_LIMIT_CODE };
  } catch (error) {
    logger.error("[usage] Daily post limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/**
 * Refuse an X publish once the X posts this UTC month reach the workspace's
 * limit, counted for its X account across every workspace (R5-security M1).
 */
export async function checkXMonthlyLimit(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ResultLimitRefusal | null> {
  try {
    const { name, limits } = await loadWorkspace(workspaceId);
    const used = await xPostsThisMonth(workspaceId, now);
    if (used < limits.xPostsPerMonth) return null;

    const { start, end } = utcMonthRange(now);
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
          windowStart: start,
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

    const { start, end } = pacificDayRange(now);
    return {
      errorCode: YOUTUBE_WORKSPACE_DAILY_LIMIT_CODE,
      errorMessage: youtubeWorkspaceDailyLimitMessage(limits.youtubeUploadsPerDay, now),
      notifyOwners: () =>
        notifyOwnersOfLimitReached({
          workspaceId,
          workspaceName: name,
          kind: "youtubeUploadsPerDay",
          limit: limits.youtubeUploadsPerDay,
          windowKey: pacificDayKey(now),
          windowEnd: end,
          windowStart: start,
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
      windowStart: utcDayRange(now).start,
      resetsAt: null,
    });
    return { error: storageFullMessage(limits.storageBytes), code: STORAGE_FULL_CODE };
  } catch (error) {
    logger.error("[usage] Storage limit check failed; allowing", { error, workspaceId });
    return null;
  }
}

/**
 * Used and limit for all four, and each owner's per-person count
 * (`viewerUserId`: who reads it, so their own line says "Your"). Throws on a
 * database error; Settings reads it through getWorkspaceUsageOrNull.
 */
export async function getWorkspaceUsage(workspaceId: string, now: Date, viewerUserId?: string): Promise<WorkspaceUsage> {
  const [limits, postsToday, xPosts, youtubeUploads, storage, people] = await Promise.all([
    getWorkspaceLimits(workspaceId),
    countPostsOnUtcDay(workspaceId, now),
    xPostsThisMonth(workspaceId, now),
    countYoutubeUploadsToday(workspaceId, now),
    storageBytesUsed(workspaceId),
    ownersPersonalUsage(workspaceId, now, viewerUserId),
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
    ...(people.length === 0
      ? {}
      : people.some((person) => person.isViewer)
        ? { people }
        : { stillToday: stillToday({ used: postsToday, limit: limits.postsPerDay, resetsAt: null }, people) }),
  };
}

/** For Settings: the usage, or null (logged) when it cannot be read, so the page still renders. */
export async function getWorkspaceUsageOrNull(
  workspaceId: string,
  now: Date,
  viewerUserId?: string,
): Promise<WorkspaceUsage | null> {
  try {
    return await getWorkspaceUsage(workspaceId, now, viewerUserId);
  } catch (error) {
    logger.error("[usage] Couldn't read the workspace's usage for Settings", { error, workspaceId });
    return null;
  }
}
