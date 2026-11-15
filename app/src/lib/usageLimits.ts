import { currentPacificMidnight, nextPacificMidnight } from "@/server/platforms/rateLimited";

import { billingEnabled, planState, type BillingFields } from "./billing";
import { isPlanKey, PLANS, type PlanLimits } from "./plans";
import { countWord } from "./plural";
import { PRODUCT_NAME } from "./siteInfo";

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
    ? `This workspace has reached its limit of ${limit} ${countWord(limit, "post", "posts")} for today. Schedule this post for another day, or try again tomorrow.`
    : `That day already has ${limit} ${countWord(limit, "post", "posts")}, which is this workspace's daily limit. Pick another day.`;
}

export function xMonthlyLimitMessage(limit: number, now: Date): string {
  const next = utcMonthRange(now).end;
  return `This X account has used its ${limit} ${countWord(limit, "X post", "X posts")} for ${utcMonthName(now)}, counted across every workspace it posts from. X posts start again on 1 ${utcMonthName(next)}.`;
}

export function youtubeWorkspaceDailyLimitMessage(limit: number): string {
  return `This workspace has reached its limit of ${limit} ${countWord(limit, "YouTube upload", "YouTube uploads")} for today. Retry this upload tomorrow.`;
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

/*
 * R5-security M1 (2026-11-14): limits that do not multiply with workspaces.
 * The per-workspace limits above stay; these count across workspaces and
 * survive a workspace's deletion (src/server/usage/usageLog.ts).
 */

/**
 * The most posts (and retries, R6-security M3) the free workspaces of the
 * whole service send in one UTC day: those on a trial, on no plan, or whose
 * plan ended. The operator's workspaces and paying ones are never counted or
 * refused here; their posts are sized in below instead (R6-security M2).
 *
 * It counts the sends written as each post goes out (Post now, the scanner
 * when a scheduled post is due, a retry), one per post per UTC day of the
 * send, and is checked at that moment, so scheduling far ahead reserves
 * nothing (src/server/usage/usageLog.ts).
 *
 * Sizing against the Inngest plan's 50,000 executions a month. About 28,000
 * are used already (CLAUDE.md: idle work, the scanners, sweeps and syncs, and
 * the operator's own posting). A post costs about 6 executions plus 1 per
 * platform, so about 10 for a post to 4 platforms. Paying workspaces are
 * expected at about 15 posts a day (five workspaces at 3). So 28,000 +
 * (40 free + 15 paid) x 10 x 31 = 45,050 in a 31-day month, which leaves about
 * 4,950 (10%) for Reels (about 10 more each) and posts to more platforms. Even
 * with every post at 6 platforms (12 each) the month is 48,460.
 */
export const SERVICE_DAILY_POST_LIMIT = 40;

/**
 * The most posts (and retries) one owner's free workspaces take in one UTC
 * day, together: with billing off every workspace, with it on every workspace
 * the service's cap counts. Sized for an agency on its trial: several client
 * workspaces at a few posts a day each (7 workspaces x 4 posts = 28) fits.
 * Below the service cap, so one person cannot take all of it.
 */
export const OWNER_DAILY_POST_LIMIT = 30;

/**
 * R6-security M2: the per-person number for an owner whose email address is
 * not confirmed, or whose account is less than NEW_ACCOUNT_HOURS old, so
 * throwaway accounts take only a small share of the service's cap. Enough to
 * try the app on the first day.
 */
export const NEW_ACCOUNT_DAILY_POST_LIMIT = 5;
export const NEW_ACCOUNT_HOURS = 24;

/** R6-security M3: how often each platform of one post may be retried in one UTC day. */
export const RETRIES_PER_POST_PER_DAY = 3;

/** Workspaces one person may create in WORKSPACES_CREATED_WINDOW_DAYS, deleted ones included. */
export const WORKSPACES_CREATED_LIMIT = 30;
export const WORKSPACES_CREATED_WINDOW_DAYS = 30;

export const OWNER_DAILY_POST_LIMIT_CODE = "OWNER_DAILY_POST_LIMIT";
export const SERVICE_DAILY_POST_LIMIT_CODE = "SERVICE_DAILY_POST_LIMIT";
export const POST_RETRY_LIMIT_CODE = "POST_RETRY_LIMIT";
export const WORKSPACE_CREATION_LIMIT_CODE = "WORKSPACE_CREATION_LIMIT";

/** The limits across workspaces also refuse a retry (R6-security M3). */
export type CrossWorkspaceLimitMode = DailyPostLimitMode | "retry";

/**
 * Whether a workspace's posts count toward its owners' per-person daily total.
 * R6-new-customer M1: with billing on, every workspace not on a running plan,
 * so also one made while billing was off (no plan, no trial) and one whose
 * plan or trial ended: every workspace the service's cap counts.
 */
export function personalPostLimitApplies(
  workspace: BillingFields,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): boolean {
  if (!billingEnabled(env)) return true;
  return !workspace.billingExempt && planState(workspace, now) !== "active";
}

/** One owner's per-person number, and whether it is the lower one for a new or unconfirmed account. */
export function ownerDailyPostLimit(
  owner: { emailVerifiedAt: Date | null; createdAt: Date },
  now: Date,
): { limit: number; reduced: boolean } {
  const ageMs = now.getTime() - owner.createdAt.getTime();
  const reduced = !owner.emailVerifiedAt || ageMs < NEW_ACCOUNT_HOURS * 60 * 60 * 1000;
  return reduced
    ? { limit: NEW_ACCOUNT_DAILY_POST_LIMIT, reduced: true }
    : { limit: OWNER_DAILY_POST_LIMIT, reduced: false };
}

function withReducedNote(sentence: string, reduced: boolean): string {
  return reduced
    ? `${sentence} The limit is ${OWNER_DAILY_POST_LIMIT} once the owner has confirmed their email address and the account is a day old.`
    : sentence;
}

/** Posting or scheduling: the owner's posts by their slot day, as the calendar shows them. */
export function ownerDailyPostLimitMessage(limit: number, mode: DailyPostLimitMode, reduced = false): string {
  const posts = `${limit} ${countWord(limit, "post", "posts")}`;
  return withReducedNote(
    mode === "now"
      ? `This workspace's owner has reached the limit of ${posts} a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.`
      : `That day already has ${posts} across all the workspaces this workspace's owner owns, which is the daily limit for one person. Pick another day.`,
    reduced,
  );
}

/** A retry (second review of K2): the owner's posts sent today, against the same number. */
export function ownerDailySendLimitMessage(limit: number, reduced = false): string {
  return withReducedNote(
    `This workspace's owner has sent ${limit} ${countWord(limit, "post", "posts")} today across the workspaces they own, the most for one day. Retry tomorrow, or schedule the post again for another day.`,
    reduced,
  );
}

export function serviceDailyPostLimitMessage(mode: CrossWorkspaceLimitMode): string {
  if (mode === "now") {
    return `${PRODUCT_NAME} has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.`;
  }
  if (mode === "retry") {
    return `${PRODUCT_NAME} has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.`;
  }
  return `That day is full: ${PRODUCT_NAME} has reached its daily limit of posts for the whole service. Pick another day.`;
}

/** On the results of a scheduled post the scanner did not send (Activity, and the owner's email). */
export function serviceDailyPostLimitAtSendMessage(): string {
  return `Not sent: ${PRODUCT_NAME} had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.`;
}

export function postRetryLimitMessage(limit: number, platform: string): string {
  return `${platform} on this post has been retried ${limit} ${countWord(limit, "time", "times")} today, the most for one day. Try again tomorrow.`;
}

/** `openAt`: when the oldest creation in the window leaves it. */
export function workspaceCreationLimitMessage(limit: number, openAt: Date): string {
  return `You have created ${limit} ${countWord(limit, "workspace", "workspaces")} in the last ${WORKSPACES_CREATED_WINDOW_DAYS} days, the most allowed. Deleted workspaces count too. You can create another from ${utcDateLabel(openAt)}.`;
}
