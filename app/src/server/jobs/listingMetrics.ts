import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { locationIdOf } from "@/server/googleReviews";
import { resolveGbpLocationName } from "@/server/platforms/gbpLocation";
import { accessTokenOf } from "@/server/jobs/reviewAlerts";

/**
 * Google listing numbers (2026-11-10). The `google-listing-metrics-sync` cron
 * runs one step, `syncListingMetrics`: for each Google connection with a chosen
 * location, oldest-checked first and for at most LISTING_METRICS_BUDGET_MS, it
 * asks Google's Business Profile Performance API for the daily numbers and
 * upserts one LocationMetricDaily row per day.
 *
 * Google's numbers arrive late and are revised, so every run asks for the last
 * LISTING_METRICS_RECENT_DAYS days again; a listing with no rows yet (new, or
 * just picked instead of another) gets LISTING_METRICS_FIRST_DAYS, so the
 * dashboard and the monthly report have history. Rows are keyed by workspace,
 * location and day, so a repeated run rewrites the same rows and a change of
 * listing never mixes two listings' numbers.
 *
 * Kept in `SocialConnection.metadata`: `listingMetricsCheckedAt` (the order of
 * the next run) and `listingMetricsCheckedFor` (the location it was checked
 * for), written by a guarded merge onto the row as it is at that moment.
 *
 * Reading these numbers changes nothing at Google. The step output is counts
 * only; logs name the connection id, never the location.
 *
 * Reference (read 2026-11-10):
 * https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries
 * https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric
 */

/** No new connection is checked after this long; the rest wait for the next day. */
export const LISTING_METRICS_BUDGET_MS = 120_000;
/** Days asked for on every run: the late and revised days come in again. */
export const LISTING_METRICS_RECENT_DAYS = 10;
/** Days asked for the first time a listing is seen. */
export const LISTING_METRICS_FIRST_DAYS = 90;
/**
 * Days per request. Google's reference states no limit on the range, so the
 * first 90 days go as one request; a longer range is split rather than sent whole.
 */
export const LISTING_METRICS_MAX_DAYS_PER_REQUEST = 90;

const PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1";
const LISTING_METRICS_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

/** The metrics asked for, and the stored column each one adds to. */
const METRIC_COLUMNS = {
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "searchViews",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "searchViews",
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "mapsViews",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "mapsViews",
  CALL_CLICKS: "calls",
  BUSINESS_DIRECTION_REQUESTS: "directionRequests",
  WEBSITE_CLICKS: "websiteClicks",
} as const;

type MetricColumn = (typeof METRIC_COLUMNS)[keyof typeof METRIC_COLUMNS];

/** Inclusive range of days, as YYYY-MM-DD. */
export interface DayRange {
  start: string;
  end: string;
}

export interface ListingDay extends Record<MetricColumn, number> {
  /** YYYY-MM-DD. */
  day: string;
}

function metadataOf(row: { metadata: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function keyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function msOf(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

/** The `days` days ending yesterday (UTC): today's numbers are never in yet. */
export function listingMetricsRange(now: Date, days: number): DayRange {
  const end = msOf(keyOf(now.getTime())) - DAY_MS;
  return { start: keyOf(end - (days - 1) * DAY_MS), end: keyOf(end) };
}

/** `range` in consecutive pieces of at most `maxDays` days, oldest first. */
export function splitDayRange(range: DayRange, maxDays: number): DayRange[] {
  const pieces: DayRange[] = [];
  const last = msOf(range.end);
  for (let start = msOf(range.start); start <= last; start += maxDays * DAY_MS) {
    pieces.push({ start: keyOf(start), end: keyOf(Math.min(start + (maxDays - 1) * DAY_MS, last)) });
  }
  return pieces;
}

/** GET locations/{id}:fetchMultiDailyMetricsTimeSeries with every metric and the range. */
export function buildListingMetricsUrl(locationId: string, range: DayRange): string {
  const url = new URL(
    `${PERFORMANCE_BASE}/locations/${encodeURIComponent(locationId)}:fetchMultiDailyMetricsTimeSeries`,
  );
  for (const metric of Object.keys(METRIC_COLUMNS)) url.searchParams.append("dailyMetrics", metric);
  for (const [name, key] of [
    ["start_date", range.start],
    ["end_date", range.end],
  ] as const) {
    const [year, month, day] = key.split("-").map(Number);
    url.searchParams.set(`dailyRange.${name}.year`, String(year));
    url.searchParams.set(`dailyRange.${name}.month`, String(month));
    url.searchParams.set(`dailyRange.${name}.day`, String(day));
  }
  return url.toString();
}

interface DatedValue {
  date?: { year?: number; month?: number; day?: number };
  value?: unknown;
}

interface PerformanceAnswer {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: Array<{
      dailyMetric?: string;
      dailySubEntityType?: unknown;
      timeSeries?: { datedValues?: DatedValue[] };
    }>;
  }>;
}

/** A count: Google sends int64 as a string and leaves the value out when it is zero. */
function countOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function dayOf(date: DatedValue["date"]): string | null {
  // A date without a day stands for a month: not a daily value.
  if (!date?.year || !date.month || !date.day) return null;
  const ms = Date.UTC(date.year, date.month - 1, date.day);
  return Number.isFinite(ms) ? keyOf(ms) : null;
}

/**
 * The days of one answer, oldest first. Every day from the first to the last
 * day Google answered (inside `range`) gets a row, a missing value or metric
 * read as zero; no day outside what Google answered is invented.
 */
export function parseListingMetrics(body: unknown, range: DayRange): ListingDay[] {
  const values = new Map<string, Partial<Record<MetricColumn, number>>>();
  for (const group of (body as PerformanceAnswer | null)?.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      const column = METRIC_COLUMNS[series.dailyMetric as keyof typeof METRIC_COLUMNS];
      // A breakdown would count the same impressions twice; none is asked for.
      if (!column || series.dailySubEntityType) continue;
      for (const point of series.timeSeries?.datedValues ?? []) {
        const day = dayOf(point.date);
        if (!day || day < range.start || day > range.end) continue;
        const sums = values.get(day) ?? {};
        sums[column] = (sums[column] ?? 0) + countOf(point.value);
        values.set(day, sums);
      }
    }
  }
  if (values.size === 0) return [];

  const answered = [...values.keys()].sort();
  const days: ListingDay[] = [];
  for (let ms = msOf(answered[0]); ms <= msOf(answered[answered.length - 1]); ms += DAY_MS) {
    const sums = values.get(keyOf(ms)) ?? {};
    days.push({
      day: keyOf(ms),
      searchViews: sums.searchViews ?? 0,
      mapsViews: sums.mapsViews ?? 0,
      calls: sums.calls ?? 0,
      directionRequests: sums.directionRequests ?? 0,
      websiteClicks: sums.websiteClicks ?? 0,
    });
  }
  return days;
}

/**
 * The daily numbers of `locationName` (a stored `accounts/{a}/locations/{id}`
 * or a store code) for `range`, one request per piece of at most `maxDays`.
 * Throws on a refusal, with code GBP_LISTING_METRICS_FETCH_FAILED and the status
 * only: Google's error body can name the location.
 */
export async function fetchListingDailyMetrics(
  accessToken: string,
  locationName: string,
  range: DayRange,
  maxDays: number = LISTING_METRICS_MAX_DAYS_PER_REQUEST,
): Promise<ListingDay[]> {
  const resourceName = await resolveGbpLocationName(accessToken, locationName);
  const locationId = locationIdOf(resourceName);
  if (!locationId) {
    throw Object.assign(new Error("The Google location could not be read"), {
      code: "GBP_LISTING_LOCATION_UNREADABLE",
    });
  }

  const days: ListingDay[] = [];
  for (const piece of splitDayRange(range, maxDays)) {
    const response = await fetchWithTimeout(
      buildListingMetricsUrl(locationId, piece),
      { headers: { Authorization: `Bearer ${accessToken}` } },
      LISTING_METRICS_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw Object.assign(new Error(`Failed to read the Google listing numbers (status ${response.status})`), {
        code: "GBP_LISTING_METRICS_FETCH_FAILED",
        status: response.status,
      });
    }
    days.push(...parseListingMetrics(await response.json(), piece));
  }
  return days;
}

/**
 * Saves the check time and the location it was for, merged onto the metadata
 * as it is NOW. Writes nothing when the connection is gone or another location
 * was chosen meanwhile.
 */
export async function saveListingMetricsCheckedAt(
  id: string,
  locationName: string,
  checkedAt: Date,
): Promise<boolean> {
  const fresh = await prisma.socialConnection.findUnique({ where: { id }, select: { metadata: true } });
  if (!fresh) return false;
  const metadata = metadataOf(fresh);
  if (nonEmptyString(metadata.locationName) !== locationName) return false;

  await prisma.socialConnection.update({
    where: { id },
    data: {
      metadata: {
        ...metadata,
        listingMetricsCheckedAt: checkedAt.toISOString(),
        listingMetricsCheckedFor: locationName,
      } as Prisma.InputJsonValue,
    },
  });
  return true;
}

export interface ListingMetricsSyncResult {
  /** Google connections found. */
  connections: number;
  /** Connections Google was asked about (or whose token refresh was tried). */
  checked: number;
  /** Connections not asked: gone, needing reconnection, or no location chosen. */
  skipped: number;
  /** Checked connections whose request failed; tried again the next day. */
  failed: number;
  /** Connections not reached before the time budget ran out. */
  left: number;
  /** Day rows written. */
  days: number;
}

/** Every Google connection's id, never-checked first, then oldest check first. */
async function collectConnectionIds(): Promise<string[]> {
  const rows = await prisma.socialConnection.findMany({
    where: { platform: "google_business_profile" },
    select: { id: true, metadata: true },
    orderBy: { id: "asc" },
  });
  const checkedAt = (row: { metadata: unknown }) => {
    const value = nonEmptyString(metadataOf(row).listingMetricsCheckedAt);
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
  };
  return rows
    .map((row) => ({ id: row.id, at: checkedAt(row) }))
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
    .map((row) => row.id);
}

/**
 * Stores every Google listing's daily numbers, connection by connection, until
 * LISTING_METRICS_BUDGET_MS has passed (`clock` is the real clock). One
 * connection's failure is logged and never stops the others.
 */
export async function syncListingMetrics(
  now: Date,
  clock: () => number = Date.now,
): Promise<ListingMetricsSyncResult> {
  const startedAt = clock();
  const ids = await collectConnectionIds();
  const result: ListingMetricsSyncResult = {
    connections: ids.length,
    checked: 0,
    skipped: 0,
    failed: 0,
    left: 0,
    days: 0,
  };

  for (let index = 0; index < ids.length; index++) {
    if (clock() - startedAt > LISTING_METRICS_BUDGET_MS) {
      result.left = ids.length - index;
      logger.info("[listing-metrics] Time budget reached; the rest are read tomorrow", { left: result.left });
      break;
    }
    const id = ids[index];

    const connection = await prisma.socialConnection.findUnique({ where: { id } });
    if (!connection) {
      result.skipped++;
      continue;
    }
    const locationName = nonEmptyString(metadataOf(connection).locationName);
    if (connection.needsReconnect || !locationName) {
      result.skipped++;
      logger.warn("[listing-metrics] Skipped a Google connection", {
        connectionId: id,
        reason: connection.needsReconnect ? "needs_reconnect" : "no_location",
      });
      continue;
    }

    result.checked++;
    try {
      const accessToken = await accessTokenOf(connection, now);
      const seen = await prisma.locationMetricDaily.findFirst({
        where: { workspaceId: connection.workspaceId, locationName },
        select: { id: true },
      });
      const range = listingMetricsRange(now, seen ? LISTING_METRICS_RECENT_DAYS : LISTING_METRICS_FIRST_DAYS);
      const days = await fetchListingDailyMetrics(accessToken, locationName, range);

      if (days.length > 0) {
        await prisma.$transaction(
          days.map(({ day, ...numbers }) => {
            const key = { workspaceId: connection.workspaceId, locationName, day: new Date(`${day}T00:00:00.000Z`) };
            return prisma.locationMetricDaily.upsert({
              where: { workspaceId_locationName_day: key },
              create: { ...key, ...numbers, fetchedAt: now },
              update: { ...numbers, fetchedAt: now },
            });
          }),
        );
      }
      result.days += days.length;
      await saveListingMetricsCheckedAt(id, locationName, now);
    } catch (error) {
      result.failed++;
      // The error kind only: a message could quote a URL with the location in it.
      logger.warn("[listing-metrics] Couldn't read a Google listing's numbers; carrying on", {
        connectionId: id,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
        status: (error as { status?: unknown } | null)?.status,
      });
      // Stamped, so a connection that keeps failing goes behind the others tomorrow.
      try {
        await saveListingMetricsCheckedAt(id, locationName, now);
      } catch {
        // Best effort: the next run reads it again either way.
      }
    }
  }

  return result;
}
