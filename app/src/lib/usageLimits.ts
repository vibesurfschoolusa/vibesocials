import { currentPacificMidnight, nextPacificMidnight } from "@/server/platforms/rateLimited";

import { billingEnabled, planState, type BillingFields } from "./billing";
import { isPlanKey, PLANS, type PlanLimits } from "./plans";

/**
 * Per-workspace usage limits (2026-11-10). Pure: no database. The numbers, the
 * windows they count in and every sentence a user or an owner reads about them
 * live here, so each is tested in one place. The counting and the checks are in
 * src/server/usage/workspaceUsage.ts.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type WorkspaceLimits = {
  postsPerDay: number;
  xPostsPerMonth: number;
  youtubeUploadsPerDay: number;
  storageBytes: number;
};

/** The Workspace columns that override a limit; null (or absent) means "not set". */
export type WorkspaceLimitOverrides = {
  limitPostsPerDay?: number | null;
  limitXPostsPerMonth?: number | null;
  limitYoutubeUploadsPerDay?: number | null;
  limitStorageMb?: number | null;
};

export type UsageLimitKind = "postsPerDay" | "xPostsPerMonth" | "youtubeUploadsPerDay" | "storage";

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  postsPerDay: 20,
  xPostsPerMonth: 30,
  youtubeUploadsPerDay: 10,
  storageBytes: 5120 * MB,
};

const DEFAULT_STORAGE_MB = 5120;

/** A whole non-negative number from the environment, parsed like youtubeDailyUploadLimit. */
function envLimit(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function pick(
  column: number | null | undefined,
  fromPlan: number | null,
  fromEnv: number | null,
  builtIn: number,
): number {
  if (column !== null && column !== undefined) return column;
  if (fromPlan !== null) return fromPlan;
  if (fromEnv !== null) return fromEnv;
  return builtIn;
}

/**
 * The plan's limits (21a), or null to resolve as before: billing off, an exempt
 * workspace, or no known plan and no trial. A workspace in trial gets starter's.
 */
function planLimits(
  workspace: BillingFields & { plan?: string | null },
  env: Record<string, string | undefined>,
  now: Date,
): PlanLimits | null {
  if (!billingEnabled(env)) return null;
  const state = planState(workspace, now);
  if (state === "exempt") return null;
  if (isPlanKey(workspace.plan)) return PLANS[workspace.plan].limits;
  if (state === "trial") return PLANS.starter.limits;
  return null;
}

/**
 * The workspace column if set, else (billing on) its plan's limit, else a valid
 * environment value, else the built-in. Zero is a limit.
 */
export function resolveWorkspaceLimits(
  overrides: WorkspaceLimitOverrides & BillingFields,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): WorkspaceLimits {
  const plan = planLimits(overrides, env, now);
  return {
    postsPerDay: pick(
      overrides.limitPostsPerDay,
      plan?.postsPerDay ?? null,
      envLimit(env, "LIMIT_POSTS_PER_DAY"),
      DEFAULT_WORKSPACE_LIMITS.postsPerDay,
    ),
    xPostsPerMonth: pick(
      overrides.limitXPostsPerMonth,
      plan?.xPostsPerMonth ?? null,
      envLimit(env, "LIMIT_X_POSTS_PER_MONTH"),
      DEFAULT_WORKSPACE_LIMITS.xPostsPerMonth,
    ),
    youtubeUploadsPerDay: pick(
      overrides.limitYoutubeUploadsPerDay,
      plan?.youtubeUploadsPerDay ?? null,
      envLimit(env, "LIMIT_YOUTUBE_UPLOADS_PER_DAY"),
      DEFAULT_WORKSPACE_LIMITS.youtubeUploadsPerDay,
    ),
    storageBytes:
      pick(overrides.limitStorageMb, plan?.storageMb ?? null, envLimit(env, "LIMIT_STORAGE_MB"), DEFAULT_STORAGE_MB) *
      MB,
  };
}

export type TimeRange = { start: Date; end: Date };

/** The UTC day `at` falls in; `end` is the next 00:00 UTC (exclusive). */
export function utcDayRange(at: Date): TimeRange {
  const [year, month, day] = [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()];
  return { start: new Date(Date.UTC(year, month, day)), end: new Date(Date.UTC(year, month, day + 1)) };
}

/** `YYYY-MM-DD` of the UTC day `at` falls in. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The UTC calendar month `at` falls in; `end` is 00:00 UTC on the 1st of the next month. */
export function utcMonthRange(at: Date): TimeRange {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

/** `YYYY-MM` of the UTC month `at` falls in. */
export function utcMonthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The Pacific day `at` falls in, the window YouTube's own quota uses (23 or 25 h on DST days). */
export function pacificDayRange(at: Date): TimeRange {
  return { start: currentPacificMidnight(at), end: nextPacificMidnight(at) };
}

// Fixed English names: the app's copy is English, and a server's locale must not change them.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function utcMonthName(at: Date): string {
  return MONTH_NAMES[at.getUTCMonth()];
}

/** "12 November" for the UTC date of `at`. */
export function utcDayMonthLabel(at: Date): string {
  return `${at.getUTCDate()} ${utcMonthName(at)}`;
}

/** "11 November 2026" for the UTC date of `at`. */
export function utcDateLabel(at: Date): string {
  return `${at.getUTCDate()} ${utcMonthName(at)} ${at.getUTCFullYear()}`;
}

/** Bytes as GB with one decimal: "5.0 GB". */
export function formatStorageGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export const DAILY_POST_LIMIT_CODE = "WORKSPACE_DAILY_POST_LIMIT";
export const X_MONTHLY_LIMIT_CODE = "X_MONTHLY_LIMIT";
export const YOUTUBE_WORKSPACE_DAILY_LIMIT_CODE = "YOUTUBE_WORKSPACE_DAILY_LIMIT";
export const STORAGE_FULL_CODE = "WORKSPACE_STORAGE_FULL";

/** `now`: a post going out now. `schedule`: a post given a day (scheduled, moved, approved for later). */
export type DailyPostLimitMode = "now" | "schedule";

export function dailyPostLimitMessage(limit: number, mode: DailyPostLimitMode): string {
  return mode === "now"
    ? `This workspace has reached its limit of ${limit} posts for today. Schedule this post for another day, or try again tomorrow.`
    : `That day already has ${limit} posts, which is this workspace's daily limit. Pick another day.`;
}

export function xMonthlyLimitMessage(limit: number, now: Date): string {
  const next = utcMonthRange(now).end;
  return `This workspace has used its ${limit} X posts for ${utcMonthName(now)}. X posts start again on 1 ${utcMonthName(next)}.`;
}

export function youtubeWorkspaceDailyLimitMessage(limit: number): string {
  return `This workspace has reached its limit of ${limit} YouTube uploads for today. Retry this upload tomorrow.`;
}

export function storageFullMessage(limitBytes: number): string {
  return `This workspace's media storage is full (${formatStorageGb(limitBytes)}). Delete media you no longer need on the Media page, then upload again.`;
}

/** Settings, when the usage could not be read. */
export const USAGE_UNAVAILABLE_MESSAGE = "Usage is not available right now.";

/** The "when it starts again" line under each limit in Settings. `resetsAt` is null for storage. */
export function usageResetText(kind: UsageLimitKind, resetsAt: Date | null): string {
  if (kind === "storage" || !resetsAt) {
    return "Frees up when media is deleted on the Media page.";
  }
  if (kind === "postsPerDay") {
    return `Starts again at 00:00 UTC on ${resetsAt.getUTCDate()} ${utcMonthName(resetsAt)}.`;
  }
  if (kind === "xPostsPerMonth") {
    return `Starts again on 1 ${utcMonthName(resetsAt)}.`;
  }
  return "Starts again at midnight Pacific time.";
}
