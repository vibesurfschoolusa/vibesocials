import { currentPacificMidnight, nextPacificMidnight } from "@/server/platforms/rateLimited";
import { usableTimeZone } from "@/server/notifications/emailTime";

import { billingEnabled, paysForPlan, planState, type BillingFields } from "./billing";
import { formatDisplayDate } from "./displayDate";
import { isPlanKey, PLANS, type PlanLimits } from "./plans";
import { countWord } from "./plural";
import { PRODUCT_NAME } from "./siteInfo";
import { waitText } from "./tooManyTriesText";

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

/** "11 November 2026" for the UTC date of `at`. */
export function utcDateLabel(at: Date): string {
  return `${at.getUTCDate()} ${utcMonthName(at)} ${at.getUTCFullYear()}`;
}

/**
 * R8-pages L8 and R9-pages L7: the UTC date of `at` as Settings writes its
 * other dates ("November 16, 2026", formatDisplayDate). Noon of that UTC date
 * in the zone it is rendered in, so the date shown is the UTC date wherever.
 */
export function utcDisplayDate(at: Date): string {
  return formatDisplayDate(`${utcDayKey(at)}T12:00:00`);
}

/** "November 21, 2026, 18:00 UTC": the date and a 24-hour time in UTC, labelled (R11-pages L3, L6). */
export function utcDisplayDateTime(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${utcDisplayDate(at)}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
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

/**
 * Who reads a refusal and when: `now` defaults to the moment it is built,
 * `timeZone` is the reader's own when it is known.
 */
export type ResetTime = { now?: Date; timeZone?: string | null };

/**
 * R46 pages-a L2: when the daily post limits start again, for "try again …"
 * and "Retry …". They reset at 00:00 UTC, so "tomorrow" was untrue for most
 * readers: in the reader's zone when it is known ("from Thursday, 7:00 PM EST
 * (00:00 UTC)"), else the wait to it, rounded up ("in 9 hours").
 */
export function dailyLimitResetText(time: ResetTime = {}): string {
  const now = time.now ?? new Date();
  const resets = utcDayRange(now).end;
  const local = firstDayEndsLocal({ firstDayEnds: resets, timeZone: time.timeZone });
  return local ? `from ${local} (00:00 UTC)` : `in ${waitText((resets.getTime() - now.getTime()) / 1000)}`;
}

export function dailyPostLimitMessage(limit: number, mode: DailyPostLimitMode, time: ResetTime = {}): string {
  return mode === "now"
    ? `This workspace has reached its limit of ${limit} ${countWord(limit, "post", "posts")} for today. Schedule this post for another day, or try again ${dailyLimitResetText(time)}.`
    : `That day already has ${limit} ${countWord(limit, "post", "posts")}, which is this workspace's daily limit. Pick another day.`;
}

export function xMonthlyLimitMessage(limit: number, now: Date): string {
  const next = utcMonthRange(now).end;
  return `This X account has used its ${limit} ${countWord(limit, "X post", "X posts")} for ${utcMonthName(now)}, counted across every workspace it posts from. X posts start again on ${utcDisplayDate(next)}.`;
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
    return `Starts again at 00:00 UTC on ${utcDisplayDate(resetsAt)}.`;
  }
  if (kind === "xPostsPerMonth") {
    return `Starts again on ${utcDisplayDate(resetsAt)}.`;
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
 * day, together (the main pool): those on a trial (a plan not yet paid for
 * too, R9 and R10-security M1), on no plan, or whose plan ended. A run is one hand-over to the background: a post going out (Post
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
 *   stale-post sweep hourly (24 x 3 = 72), the connection sweep (8), the
 *   token refreshes it fans out (about 1 a day, 1 x 2 = 2: free workspaces'
 *   refreshes run inline in the sweep's own step, one after another, and
 *   only paid, operator-owned and grandfathered ones are fanned out; V3,
 *   round 10), and the other daily jobs (15): 505 a day. 525 is used below,
 *   which leaves room for a day with more fanned-out refreshes.
 *   R9-publishing L2: the least the idle work costs (each run finding
 *   nothing to do); a day with work costs more.
 * - A typical run, a photo or a small video to 6 platforms: the publish run,
 *   its fetch step, a step per platform, finalize and the outcome event (10),
 *   and the outcome email's run and step (2): 12. Not the most a run costs: a
 *   step per result row (skipped failed ones too), a Feed and Story half's
 *   wait and second email, and a large video (over 50 MiB) to X, LinkedIn or
 *   YouTube continuing in extra steps make a large chunked video to several
 *   platforms about 25. A day of about 20 such runs would use up the ~1,019
 *   left before the ceiling is reached, so the operator's email (sent at the
 *   first ceiling refusal, FREE_RUNS_DAILY_CEILING) can come after that day's
 *   overrun, or not at all; check Inngest's usage page weekly until the plan
 *   is upgraded.
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
 * are never counted or refused. Sized on typical runs (12 each, see above):
 * idle 525 + 30 x 12 = 885 a day against the ~1,019 left, leaving ~134 a day
 * for paying workspaces and the operator. 30 large chunked videos (~25 each)
 * would not fit; the operator's email that day is the warning. It allows the
 * full pools (25) and five guaranteed runs past them.
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
/** Review of T1, item 1: a free run whose limits could not be checked is not sent (the ceiling is hard). */
export const LIMIT_CHECK_FAILED_CODE = "LIMIT_CHECK_FAILED";
export const LIMIT_CHECK_FAILED_MESSAGE = "We couldn't check today's limits. Try again in a minute.";
export const SERVICE_DAILY_POST_LIMIT_CODE = "SERVICE_DAILY_POST_LIMIT";
export const POST_RETRY_LIMIT_CODE = "POST_RETRY_LIMIT";
export const WORKSPACE_CREATION_LIMIT_CODE = "WORKSPACE_CREATION_LIMIT";

/** The limits across workspaces also refuse a retry (R6-security M3). */
export type CrossWorkspaceLimitMode = DailyPostLimitMode | "retry";

/**
 * Whether a workspace's posts count toward its owners' per-person daily total.
 * R6-new-customer M1: with billing on, every workspace not on a paid plan,
 * so also one made while billing was off (no plan, no trial) and one whose
 * plan or trial ended: every workspace the service's cap counts.
 * R9-security M1 and R10-security M1: and one whose plan is not yet paid
 * for (paysForPlan: in its card trial, or with no paid invoice recorded).
 */
export function personalPostLimitApplies(
  workspace: BillingFields,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): boolean {
  if (!billingEnabled(env)) return true;
  return !workspace.billingExempt && !paysForPlan(workspace, now);
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
 * R14-pages L2 / R15-new-customer L3: the one label for naming a person to
 * another person (posts' "by", the approval-requested email, the limit
 * sentences, Settings, Usage), so a reader sees each person called one thing:
 * their name, else their full address to an owner (owners see the roster's
 * addresses), else, to anyone else, only the part before the @ (R13-security
 * L1, the roster rule).
 */
export function personLabel(user: { name?: string | null; email: string }, readerIsOwner: boolean): string {
  return user.name?.trim() || (readerIsOwner ? user.email : user.email.split("@")[0]);
}

/**
 * When the first day ends, for the sentence: 00:00 UTC, and the same moment
 * in the reader's own zone when it is known (R8-new-customer L2).
 */
export type ReducedNoteTime = ResetTime & { firstDayEnds?: Date };

/** The first day's end in the reader's own zone ("Monday, 7:00 PM EST"), or null when either is unknown. */
export function firstDayEndsLocal(time: ReducedNoteTime): string | null {
  const zone = usableTimeZone(time.timeZone);
  if (!time.firstDayEnds || !zone) return null;
  return time.firstDayEnds.toLocaleString("en-US", {
    timeZone: zone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function firstDayEndsText(time: ReducedNoteTime): string {
  const local = firstDayEndsLocal(time);
  return local ? `from ${local} (00:00 UTC)` : "from 00:00 UTC tomorrow";
}

/** R10-pages M1: with billing on, what a person's number counts: free workspaces and plans not yet paid for. */
const NOT_YET_PAID_FOR = "workspaces not yet paid for";

/**
 * R9-pages L4 and R10-pages M1: the workspaces a person's number counts,
 * after "across". With billing on a paid workspace is left out
 * (personalPostLimitApplies) but a plan in its card trial or before its first
 * payment is not, so the sentences say "not yet paid for" rather than "free";
 * with it off every workspace counts. `whose`: "they" (the owner in the
 * sentence) or "owner" (this workspace's owner).
 */
function ownedWorkspaces(env: Record<string, string | undefined>, all: boolean, whose: "they" | "owner" = "they"): string {
  if (billingEnabled(env)) return whose === "they" ? `their ${NOT_YET_PAID_FOR}` : `this workspace's owner's ${NOT_YET_PAID_FOR}`;
  return `${all ? "all the" : "the"} workspaces ${whose === "they" ? "they own" : "this workspace's owner owns"}`;
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
  env: Record<string, string | undefined> = process.env,
): string {
  const posts = `${limit} ${countWord(limit, "post", "posts")}`;
  const named = holder !== null && holder.coOwned && !holder.isViewer;
  const who = named ? `${holder.name}, an owner of this workspace,` : "This workspace's owner";
  const sentence =
    mode === "now"
      ? `${who} has reached the limit of ${posts} a day across ${ownedWorkspaces(env, true)}, and retries count toward it. Schedule this post for another day, or try again ${dailyLimitResetText(time)}.`
      : mode === "retry"
        ? `${who} has reached the limit of ${posts} a day across ${ownedWorkspaces(env, false)}, and retries count toward it. Retry ${dailyLimitResetText(time)}, or schedule the post again for another day.`
        : named
          ? `${who} already has ${posts} that day across ${ownedWorkspaces(env, false)}, which is the daily limit for one person (retries count toward it). Pick another day.`
          : `That day already has ${posts} across ${ownedWorkspaces(env, true, "owner")}, which is the daily limit for one person (retries count toward it). Pick another day.`;
  return reduced ? `${sentence} ${reducedNote(reduced, holder, named, time)}` : sentence;
}

/**
 * R8-pages M1: Settings, Usage's line for one owner's per-person number, the
 * one that binds a free workspace: whose it is, and why it is the lower one.
 * R9-pages L4 and R10-pages M1: with billing on it counts only the
 * workspaces not yet paid for, and says so. R9-pages L5: no one can raise
 * it, so the note says it is the same for everyone (Settings' "write to us"
 * is about the workspace's own limits).
 * R9-pages L7: on the first day, `time` gives the reader's own time.
 */
export function personalUsageText(
  person: { name: string; isViewer: boolean; reduced: ReducedReason | null },
  coOwned: boolean,
  time: ReducedNoteTime = {},
  env: Record<string, string | undefined> = process.env,
): { label: string; note: string } {
  const billing = billingEnabled(env);
  const label = person.isViewer
    ? `Your posts today (UTC), ${billing ? `your ${NOT_YET_PAID_FOR}` : "all your workspaces"}`
    : `${coOwned ? `${person.name}'s` : "The owner's"} posts today (UTC), ${billing ? `their ${NOT_YET_PAID_FOR}` : "all their workspaces"}`;
  const confirms = person.isViewer
    ? "you confirm your email address"
    : `${coOwned ? person.name : "the owner"} confirms their email address`;
  const low = NEW_ACCOUNT_DAILY_POST_LIMIT;
  const full = OWNER_DAILY_POST_LIMIT;
  const why =
    person.reduced === "unconfirmed"
      ? ` ${low} until ${confirms}, then ${full}.`
      : person.reduced === "first_day"
        ? ` ${low} on the account's first day (UTC), ${full} ${firstDayEndsText(time)}.`
        : person.reduced === "first_day_unconfirmed"
          ? ` ${low} on the account's first day (UTC), ${full} ${firstDayEndsText(time)} once ${confirms}.`
          : "";
  const same = billing
    ? // R11-pages L7: paying doesn't raise the number; a paid workspace's posts are left out of it.
      "The per-person number is the same for everyone; posts in a paid workspace don't count toward it."
    : "The per-person number is the same for everyone.";
  return { label, note: `Retries count too.${why} ${same}` };
}

/**
 * Review of T1, item 4: what a member reads instead of the owners' counts:
 * how many posts this workspace can still send today, and which limit
 * decides it, with no owner named.
 */
export function stillTodayText(
  still: { remaining: number; decidedBy: "workspace" | "owner"; coOwned: boolean },
  env: Record<string, string | undefined> = process.env,
): {
  label: string;
  note: string;
} {
  const posts = `${still.remaining} ${countWord(still.remaining, "post", "posts")}`;
  return {
    label: "Posts this workspace can still send today (UTC)",
    note:
      still.decidedBy === "workspace"
        ? `This workspace's own daily limit leaves ${posts}.`
        : `The daily limit of ${still.coOwned ? "one of its owners" : "its owner"}, counted across ${ownedWorkspaces(env, true)} (retries too), leaves ${posts}.`,
  };
}

export function serviceDailyPostLimitMessage(mode: CrossWorkspaceLimitMode, time: ResetTime = {}): string {
  if (mode === "now") {
    return `${PRODUCT_NAME} has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again ${dailyLimitResetText(time)}.`;
  }
  if (mode === "retry") {
    return `${PRODUCT_NAME} has reached its daily limit of posts for the whole service, and retries count toward it. Retry ${dailyLimitResetText(time)}.`;
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
export function newAccountPoolMessage(mode: CrossWorkspaceLimitMode, time: ResetTime = {}): string {
  const posts = `${NEW_ACCOUNT_POOL_DAILY_LIMIT} ${countWord(NEW_ACCOUNT_POOL_DAILY_LIMIT, "post", "posts")}`;
  if (mode === "now") {
    return `${PRODUCT_NAME} has reached today's limit of ${posts} ${NEW_ACCOUNT_POOL_WHO}. Schedule this post for another day, or try again ${dailyLimitResetText(time)}. ${LEAVE_NEW_ACCOUNT_POOL}`;
  }
  if (mode === "retry") {
    return `${PRODUCT_NAME} has reached today's limit of ${posts} ${NEW_ACCOUNT_POOL_WHO}, and retries count toward it. Retry ${dailyLimitResetText(time)}. ${LEAVE_NEW_ACCOUNT_POOL}`;
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
 * which is one run, only when the post's card has the button: it covers 2 or
 * more failed platforms (R8-publishing L3, R8-pages L6).
 */
export function postRetryLimitMessage(limit: number, retryAllPlatforms: number, time: ResetTime = {}): string {
  const sentence = `This post has been retried ${limit} ${countWord(limit, "time", "times")} today, the most for one day. Try again ${dailyLimitResetText(time)}.`;
  return retryAllPlatforms >= 2
    ? `${sentence} Retry all failed retries every failed platform of a post at once and counts as one retry.`
    : sentence;
}


/**
 * `openAt`: when the oldest creation in the window leaves it. R11-pages L6: the
 * time too, since the day alone is wrong until that hour; part of a minute is
 * rounded up so the time named is never still refused.
 */
export function workspaceCreationLimitMessage(limit: number, openAt: Date): string {
  const opens = new Date(Math.ceil(openAt.getTime() / 60_000) * 60_000);
  return `You have created ${limit} ${countWord(limit, "workspace", "workspaces")} in the last ${WORKSPACES_CREATED_WINDOW_DAYS} days, the most allowed. Deleted workspaces count too. You can create another from ${utcDisplayDateTime(opens)}.`;
}
