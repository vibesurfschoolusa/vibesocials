/**
 * Monthly report (18a, 2026-11-10): the object both report pages render, and
 * the pure parts that build it. The server half is
 * src/server/reports/monthlyReport.ts.
 *
 * The client's page (/v/[token]/report) receives this object and nothing else,
 * so every field here is one a signed-out holder of the review link may see:
 * no ids, no people, no settings, no error text.
 */

import type { ListingMetricRow, ListingMetricTotals } from "./listingMetrics";
import { truncateGraphemes } from "./truncate";

/** Most posts one report lists. */
export const REPORT_POST_MAX = 200;
/** How many full months back a report may go. */
export const REPORT_MONTHS_BACK = 12;
/** Longest caption shown per post, in characters. */
export const REPORT_CAPTION_MAX = 200;

export const REPORT_UTC_NOTE = "Months are counted in UTC.";

export const REPORT_MONTH_INVALID_MESSAGE =
  "Choose a month from the list. Reports cover this month and the 12 months before it.";

export type ReportNumberKey = "views" | "likes" | "comments" | "shares" | "clicks" | "saves";

export const REPORT_NUMBER_KEYS: readonly ReportNumberKey[] = [
  "views",
  "likes",
  "comments",
  "shares",
  "clicks",
  "saves",
];

export const REPORT_NUMBER_LABELS: Record<ReportNumberKey, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  clicks: "Clicks",
  saves: "Saves",
};

/** One platform a post went out on in the month. */
export interface ReportPlatformResult {
  /** The platform's name, e.g. "Instagram". */
  platform: string;
  /** True when it went out as a Story. */
  story: boolean;
  /** The public link, decided as Activity decides it; null when there is none. */
  url: string | null;
  /** Only the numbers the platform gave (a missing key means none). */
  numbers: Partial<Record<ReportNumberKey, number>>;
}

export interface ReportPost {
  /** ISO-8601: the latest of its results that succeeded in the month. */
  publishedAt: string;
  /** The post's own caption, at most 200 characters. */
  caption: string;
  /** The first file's public address; null when it was removed (show a placeholder). */
  media: { url: string; mimeType: string } | null;
  mediaCount: number;
  platforms: ReportPlatformResult[];
}

export interface ReportNumberTotal {
  key: ReportNumberKey;
  label: string;
  sum: number;
  /** How many posts have this number: the sum covers these only. */
  posts: number;
}

export interface ReportListing {
  /** Days of the month with stored numbers. */
  daysCovered: number;
  /** Days of the month counted: all of them, or up to today for the month in progress. */
  daysCounted: number;
  /** The month is not over yet. */
  partial: boolean;
  totals: ListingMetricTotals;
  /** The month before, only when both months are fully covered; else null. */
  previous: ListingMetricTotals | null;
}

export interface MonthlyReport {
  /** YYYY-MM, a UTC calendar month. */
  month: string;
  workspaceName: string;
  /** The workspace's logo, a public PNG address; null when it has none. */
  logoUrl: string | null;
  /** The month is not over yet. */
  inProgress: boolean;
  /** Posts with a result that succeeded in the month (all of them, not only those listed). */
  postCount: number;
  /** Newest first, at most 200. */
  posts: ReportPost[];
  totals: {
    /** Results that succeeded in the month, per platform. */
    resultsByPlatform: { platform: string; count: number }[];
    /** Over the listed posts. */
    numbers: ReportNumberTotal[];
  };
  /** Null when there is no listing or no stored day in the month. */
  listing: ReportListing | null;
  /** Results that failed in the month, per platform. */
  failed: { platform: string; count: number }[];
}

function listingTotals(t: ListingMetricTotals): ListingMetricTotals {
  return { views: t.views, calls: t.calls, directionRequests: t.directionRequests, websiteClicks: t.websiteClicks };
}

/**
 * The report rebuilt field by field, for the signed-out page: whatever else an
 * object carries (a later field, a row's id), only the documented fields leave.
 */
export function publicMonthlyReport(report: MonthlyReport): MonthlyReport {
  const counts = (list: { platform: string; count: number }[]) =>
    list.map(({ platform, count }) => ({ platform, count }));
  return {
    month: report.month,
    workspaceName: report.workspaceName,
    logoUrl: report.logoUrl,
    inProgress: report.inProgress,
    postCount: report.postCount,
    posts: report.posts.map((post) => ({
      publishedAt: post.publishedAt,
      caption: post.caption,
      media: post.media ? { url: post.media.url, mimeType: post.media.mimeType } : null,
      mediaCount: post.mediaCount,
      platforms: post.platforms.map((p) => {
        const numbers: Partial<Record<ReportNumberKey, number>> = {};
        for (const key of REPORT_NUMBER_KEYS) {
          if (typeof p.numbers[key] === "number") numbers[key] = p.numbers[key];
        }
        return { platform: p.platform, story: p.story, url: p.url, numbers };
      }),
    })),
    totals: {
      resultsByPlatform: counts(report.totals.resultsByPlatform),
      numbers: report.totals.numbers.map(({ key, label, sum, posts }) => ({ key, label, sum, posts })),
    },
    listing: report.listing
      ? {
          daysCovered: report.listing.daysCovered,
          daysCounted: report.listing.daysCounted,
          partial: report.listing.partial,
          totals: listingTotals(report.listing.totals),
          previous: report.listing.previous ? listingTotals(report.listing.previous) : null,
        }
      : null,
    failed: counts(report.failed),
  };
}

const MONTH_PATTERN =/^(\d{4})-(0[1-9]|1[0-2])$/;

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** YYYY-MM `n` months after `month` (before, when negative). */
export function shiftMonth(month: string, n: number): string {
  const [year, mon] = month.split("-").map(Number);
  return monthOf(new Date(Date.UTC(year, mon - 1 + n, 1)));
}

/** The month's first instant and the next month's first instant, in UTC. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(year, mon - 1, 1)), end: new Date(Date.UTC(year, mon, 1)) };
}

export function daysInMonth(month: string): number {
  const { start, end } = monthBounds(month);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** The month in progress, then the 12 full months before it. */
export function reportMonths(now: Date): string[] {
  const current = monthOf(now);
  return Array.from({ length: REPORT_MONTHS_BACK + 1 }, (_, i) => shiftMonth(current, -i));
}

export function defaultReportMonth(now: Date): string {
  return shiftMonth(monthOf(now), -1);
}

export type ParsedReportMonth =
  | { ok: true; month: string; inProgress: boolean }
  | { ok: false; error: string };

/** The month a request asks for: missing gives the last full month; anything not in the list is refused. */
export function parseReportMonth(value: unknown, now: Date): ParsedReportMonth {
  const month = value === undefined || value === null || value === "" ? defaultReportMonth(now) : value;
  if (typeof month !== "string" || !MONTH_PATTERN.test(month) || !reportMonths(now).includes(month)) {
    return { ok: false, error: REPORT_MONTH_INVALID_MESSAGE };
  }
  return { ok: true, month, inProgress: month === monthOf(now) };
}

/** "October 2026". */
export function monthLabel(month: string): string {
  return monthBounds(month).start.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function reportCaption(text: string): string {
  return truncateGraphemes(text, REPORT_CAPTION_MAX, { ellipsis: "…" });
}

/** Per number: the sum over the posts that have it, and how many posts those are. */
export function summarizePostNumbers(posts: ReportPost[]): ReportNumberTotal[] {
  return REPORT_NUMBER_KEYS.flatMap((key) => {
    let sum = 0;
    let covered = 0;
    for (const post of posts) {
      const values = post.platforms
        .map((p) => p.numbers[key])
        .filter((v): v is number => typeof v === "number");
      if (values.length === 0) continue;
      covered += 1;
      sum += values.reduce((a, b) => a + b, 0);
    }
    return covered ? [{ key, label: REPORT_NUMBER_LABELS[key], sum, posts: covered }] : [];
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Likes: 312 across 18 posts". */
export function numberLine(total: ReportNumberTotal): string {
  return `${total.label}: ${total.sum} across ${plural(total.posts, "post", "posts")}`;
}

/** Null when every post is listed. */
export function showingLine(shown: number, total: number): string | null {
  return total > shown ? `Showing the ${shown} most recent of ${total}.` : null;
}

export function failedLine(entry: { platform: string; count: number }): string {
  return `${plural(entry.count, "post", "posts")} did not publish on ${entry.platform}`;
}

function zero(): ListingMetricTotals {
  return { views: 0, calls: 0, directionRequests: 0, websiteClicks: 0 };
}

/** Sum of the rows inside [start, end), and how many distinct days they cover. */
function sumDays(rows: ListingMetricRow[], start: Date, end: Date) {
  const totals = zero();
  const days = new Set<string>();
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  for (const row of rows) {
    const key = typeof row.day === "string" ? row.day.slice(0, 10) : row.day.toISOString().slice(0, 10);
    if (key < from || key >= to || days.has(key)) continue;
    days.add(key);
    totals.views += row.searchViews + row.mapsViews;
    totals.calls += row.calls;
    totals.directionRequests += row.directionRequests;
    totals.websiteClicks += row.websiteClicks;
  }
  return { totals, covered: days.size };
}

/**
 * The listing's month from the current listing's stored days (this month and
 * the one before). A day Google did not answer has no row: it is missing, and
 * the coverage says so; it is never read as zero. The comparison is like for
 * like: only when this month is over and every day of both months is stored.
 */
export function summarizeListingMonth(
  rows: ListingMetricRow[],
  month: string,
  now: Date,
): ReportListing | null {
  const { start, end } = monthBounds(month);
  const current = sumDays(rows, start, end);
  if (current.covered === 0) return null;

  const partial = monthOf(now) === month;
  const daysCounted = partial ? now.getUTCDate() : daysInMonth(month);

  const previousMonth = shiftMonth(month, -1);
  const before = monthBounds(previousMonth);
  const previous = sumDays(rows, before.start, before.end);
  const comparable =
    !partial && current.covered === daysInMonth(month) && previous.covered === daysInMonth(previousMonth);

  return {
    daysCovered: current.covered,
    daysCounted,
    partial,
    totals: current.totals,
    previous: comparable ? previous.totals : null,
  };
}
