import { currentPacificMidnight, nextPacificMidnight } from "@/server/platforms/rateLimited";
import { usableTimeZone } from "@/server/notifications/emailTime";

import { billingEnabled, planState, type BillingFields } from "./billing";
import { formatDisplayDate } from "./displayDate";
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
    // R8-pages L8: written like Settings' other dates. Noon of that UTC date in
    // the zone it is rendered in, so the date shown is the UTC date wherever.
    return `Starts again at 00:00 UTC on ${formatDisplayDate(`${utcDayKey(resetsAt)}T12:00:00`)}.`;
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
 * The runs the free workspaces of confirmed, day-old accounts send in one UTC
 * day, together (the main pool): those on a trial, on no plan, or whose plan
 * ended. A run is one hand-over to the background: a post going out (Post
 * now, or the scanner when a scheduled one is due) or one retry request,
 * however many platforms it has. The operator's workspaces and paying ones are
 * never counted or refused here (R7-security L1).
 *
 * Each run is a row written as it is handed over and checked at that moment
 * (src/server/usage/usageLog.ts), so scheduling far ahead reserves nothing.
 * The row records the pool it drew from and the workspace's owners at that
 * time (R7-security M1).
 *
 * Sizing (R7-security M1 and its review, 14 Nov 2026), against the Inngest
 * Hobby plan's 50,000 executions a month, counting each run and each step:
 * - Used by 14 Nov: 33,687 (33,594 earlier that day; most of it testing),
 *   so 16,313 are left for 15 to 30 November: about 1,019 a day.
 * - Idle work, each scheduled run with nothing to do (1 for the run, 1 per
 *   step): the scanner every 10 minutes (144 x 2 = 288), media retention
 *   hourly (24 x 3 = 72), YouTube numbers hourly (24 x 2 = 48), the
 *   stale-post sweep hourly (24 x 3 = 72), the connection sweep (8) and the
 *   token refreshes it fans out (about 10 x 2 = 20), and the other daily jobs
 *   (15): 523 a day, call it 525.
 * - A run to 6 platforms: the publish run, its fetch step, a step per
 *   platform, finalize and the outcome event (10), and the outcome email's
 *   run and step (2): 12.
 * - A full day of free runs at both pools: (20 + 5) x 12 = 300. With idle
 *   work, 825 a day, which leaves about 194 a day for paying workspaces, the
 *   operator's own posts and the guaranteed runs below that go past a full
 *   pool (3 x 12 = 36 each). From December (31 days): (525 + 300) x 31 =
 *   25,575, about half the plan.
 * - The guaranteed runs are bounded by FREE_RUNS_DAILY_CEILING below.
 */
export const SERVICE_DAILY_POST_LIMIT = 20;

/**
 * R8-security M1: the one hard ceiling of free runs a UTC day: every run the
 * pools count (main and new-account, guaranteed runs included), together.
 * Below it the pools, the per-person numbers and the guaranteed share apply as
 * they are; at it every free run is refused with the service sentence, and
 * the operator is emailed once that day. Paying workspaces and the operator's
 * are never counted or refused. Sized so the worst free day still fits: idle
 * 525 + 30 x 12 = 885 a day against the ~1,019 left, leaving ~134 a day for
 * paying workspaces and the operator. It allows the full pools (25) and five
 * guaranteed runs past them.
 */
export const FREE_RUNS_DAILY_CEILING = 30;

/**
 * R7-security M1 (a): the runs a UTC day, across the whole service, of
 * workspaces none of whose owners is an established account (isNewAccount:
 * email not confirmed, or made that UTC day). They draw only from this pool
 * and never from the main one, so throwaway registrations can use up only this.
 */
export const NEW_ACCOUNT_POOL_DAILY_LIMIT = 5;

/**
 * R7-security M1 (b): each established person's first runs a UTC day are
 * never refused by the main pool (they still count in it), so strangers
 * filling the pool cannot stop a customer's day. Bounded by
 * FREE_RUNS_DAILY_CEILING (R8-security M1).
 */
export const GUARANTEED_RUNS_PER_PERSON = 3;

/**
 * The most runs one established owner's free workspaces take in one UTC day,
 * together, counting the posts still scheduled for later that day:
 * with billing off every workspace, with it on every workspace the pools
 * count. Below the main pool, so one person cannot take all of it.
 */
export const OWNER_DAILY_POST_LIMIT = 15;

/**
 * R6-security M2 and the R7 review: the per-person number of a new account
 * (isNewAccount: the UTC day it was made, and every day until its email
 * address is confirmed). Enough to try the app on the first day.
 */
export const NEW_ACCOUNT_DAILY_POST_LIMIT = 5;

/** R7-security L1: the retry runs one post may have in one UTC day, all its platforms together. */
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

/**
 * R8-new-customer M1: the one definition of a new account, for the pools and
 * the per-person number alike: on the UTC day it was made, and on every day
 * until its email address is confirmed. A new account draws from the
 * new-account pool, has no guaranteed share and the lower per-person number.
 */
export function isNewAccount(owner: { emailVerifiedAt: Date | null; createdAt: Date }, at: Date): boolean {
  return !owner.emailVerifiedAt || utcDayKey(owner.createdAt) === utcDayKey(at);
}

/**
 * Why an owner has the lower per-person number: the email is unconfirmed, the
 * day is the account's first, or both (the first day of an unconfirmed account).
 */
export type ReducedReason = "unconfirmed" | "first_day" | "first_day_unconfirmed";

/** One owner's per-person number for the UTC day of `day` (isNewAccount), and why it is the lower one. */
export function ownerDailyPostLimit(
  owner: { emailVerifiedAt: Date | null; createdAt: Date },
  day: Date,
): { limit: number; reduced: ReducedReason | null } {
  if (!isNewAccount(owner, day)) return { limit: OWNER_DAILY_POST_LIMIT, reduced: null };
  const firstDay = utcDayKey(owner.createdAt) === utcDayKey(day);
  const reduced: ReducedReason = !firstDay ? "unconfirmed" : owner.emailVerifiedAt ? "first_day" : "first_day_unconfirmed";
  return { limit: NEW_ACCOUNT_DAILY_POST_LIMIT, reduced };
}

/**
 * The owner whose number held the post back, as the sentence needs them
 * (second look, point 1): their name (else email), whether the workspace has
 * other owners, and whether they are the person reading it.
 */
export type LimitHolder = { name: string; coOwned: boolean; isViewer: boolean };

/**
 * When the first day ends, for the sentence: 00:00 UTC, and the same moment
 * in the reader's own zone when it is known (R8-new-customer L2).
 */
export type ReducedNoteTime = { firstDayEnds?: Date; timeZone?: string | null };

function firstDayEndsText(time: ReducedNoteTime): string {
  const zone = usableTimeZone(time.timeZone);
  if (!time.firstDayEnds || !zone) return "from 00:00 UTC tomorrow";
  const local = time.firstDayEnds.toLocaleString("en-US", {
    timeZone: zone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `from 00:00 UTC tomorrow (${local})`;
}

/** When the lower number ends, both conditions on the first day: "you" only to the owner themself. */
function reducedNote(reduced: ReducedReason, holder: LimitHolder | null, named: boolean, time: ReducedNoteTime): string {
  const confirms = holder?.isViewer
    ? "you confirm your email address"
    : `${holder?.name ?? "the owner"} confirms their email address`;
  const full = `${named ? "Their" : "The"} limit is ${OWNER_DAILY_POST_LIMIT}`;
  if (reduced === "first_day") return `${full} ${firstDayEndsText(time)}.`;
  if (reduced === "first_day_unconfirmed") return `${full} ${firstDayEndsText(time)}, once ${confirms}.`;
  return `The limit is ${OWNER_DAILY_POST_LIMIT} once ${confirms}.`;
}

/**
 * The per-person sentence (posting now, scheduling by slot day, a retry).
 * Retries count toward the number, so every mode says so (R8-pages L2). In a
 * co-owned workspace the owner whose number holds it is named, unless they
 * are the one reading it (R7 review point 6, R8-pages L3).
 */
export function ownerDailyPostLimitMessage(
  limit: number,
  mode: CrossWorkspaceLimitMode,
  reduced: ReducedReason | null = null,
  holder: LimitHolder | null = null,
  time: ReducedNoteTime = {},
): string {
  const posts = `${limit} ${countWord(limit, "post", "posts")}`;
  const named = holder !== null && holder.coOwned && !holder.isViewer;
  const who = named ? `${holder.name}, an owner of this workspace,` : "This workspace's owner";
  const sentence =
    mode === "now"
      ? `${who} has reached the limit of ${posts} a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow.`
      : mode === "retry"
        ? `${who} has reached the limit of ${posts} a day across the workspaces they own, and retries count toward it. Retry tomorrow, or schedule the post again for another day.`
        : named
          ? `${who} already has ${posts} that day across the workspaces they own, which is the daily limit for one person (retries count toward it). Pick another day.`
          : `That day already has ${posts} across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). Pick another day.`;
  return reduced ? `${sentence} ${reducedNote(reduced, holder, named, time)}` : sentence;
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

const LEAVE_NEW_ACCOUNT_POOL =
  "It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.";
const NEW_ACCOUNT_POOL_WHO = "shared by accounts made today (UTC) or with an unconfirmed email address";

/** R7-security M1: the new-account pool, when posting, scheduling or retrying. */
export function newAccountPoolMessage(mode: CrossWorkspaceLimitMode): string {
  const posts = `${NEW_ACCOUNT_POOL_DAILY_LIMIT} ${countWord(NEW_ACCOUNT_POOL_DAILY_LIMIT, "post", "posts")}`;
  if (mode === "now") {
    return `${PRODUCT_NAME} has reached today's limit of ${posts} ${NEW_ACCOUNT_POOL_WHO}. Schedule this post for another day, or try again tomorrow. ${LEAVE_NEW_ACCOUNT_POOL}`;
  }
  if (mode === "retry") {
    return `${PRODUCT_NAME} has reached today's limit of ${posts} ${NEW_ACCOUNT_POOL_WHO}, and retries count toward it. Retry tomorrow. ${LEAVE_NEW_ACCOUNT_POOL}`;
  }
  return `That day is full: ${PRODUCT_NAME} has reached the limit of ${posts} a day ${NEW_ACCOUNT_POOL_WHO}. Pick another day. ${LEAVE_NEW_ACCOUNT_POOL}`;
}

/** On the results of a scheduled post of a new account the scanner did not send. */
export function newAccountPoolAtSendMessage(): string {
  const posts = `${NEW_ACCOUNT_POOL_DAILY_LIMIT} ${countWord(NEW_ACCOUNT_POOL_DAILY_LIMIT, "post", "posts")}`;
  return `Not sent: ${PRODUCT_NAME} had reached the day's limit of ${posts} ${NEW_ACCOUNT_POOL_WHO} when this post was due. Retry it tomorrow, or schedule it again. ${LEAVE_NEW_ACCOUNT_POOL}`;
}

/**
 * R7-security L1: the retry runs of one post. It points to Retry all failed,
 * which is one run, only when the post has the button: 2 or more failed
 * platforms (R8-publishing L3).
 */
export function postRetryLimitMessage(limit: number, failedPlatforms: number): string {
  const sentence = `This post has been retried ${limit} ${countWord(limit, "time", "times")} today, the most for one day. Try again tomorrow.`;
  return failedPlatforms >= 2
    ? `${sentence} Retry all failed retries every failed platform of a post at once and counts as one retry.`
    : sentence;
}


/** `openAt`: when the oldest creation in the window leaves it. */
export function workspaceCreationLimitMessage(limit: number, openAt: Date): string {
  return `You have created ${limit} ${countWord(limit, "workspace", "workspaces")} in the last ${WORKSPACES_CREATED_WINDOW_DAYS} days, the most allowed. Deleted workspaces count too. You can create another from ${utcDateLabel(openAt)}.`;
}
