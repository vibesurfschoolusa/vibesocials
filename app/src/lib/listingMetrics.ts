/**
 * The Google listing card's sums (2026-11-10). Pure: the route reads the rows
 * of LocationMetricDaily for one workspace and location and hands them here.
 */

import { formatNumber } from "./formatNumber";

export interface ListingMetricRow {
  /** The day the numbers are for: a Date at UTC midnight (Prisma's @db.Date), or YYYY-MM-DD. */
  day: Date | string;
  searchViews: number;
  mapsViews: number;
  calls: number;
  directionRequests: number;
  websiteClicks: number;
}

export interface ListingMetricTotals {
  /** Search plus Maps impressions. */
  views: number;
  calls: number;
  directionRequests: number;
  websiteClicks: number;
}

export interface ListingMetricsSummary {
  /**
   * The end of the current window (YYYY-MM-DD): the newest day with any number
   * above zero, or the newest stored day when every day is zero; null with no rows.
   */
  endDay: string | null;
  /** The `windowDays` days ending on endDay; null with no rows. */
  current: ListingMetricTotals | null;
  /** The `windowDays` days before those; null unless a row is stored on that window's first day. */
  previous: ListingMetricTotals | null;
}

const DAY_MS = 86_400_000;

function dayKey(day: Date | string): string {
  return typeof day === "string" ? day.slice(0, 10) : day.toISOString().slice(0, 10);
}

/** YYYY-MM-DD `days` days after `key` (before, when negative). */
export function shiftDay(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function zero(): ListingMetricTotals {
  return { views: 0, calls: 0, directionRequests: 0, websiteClicks: 0 };
}

function add(totals: ListingMetricTotals, row: ListingMetricRow): void {
  totals.views += row.searchViews + row.mapsViews;
  totals.calls += row.calls;
  totals.directionRequests += row.directionRequests;
  totals.websiteClicks += row.websiteClicks;
}

function hasNumber(row: ListingMetricRow): boolean {
  return row.searchViews + row.mapsViews + row.calls + row.directionRequests + row.websiteClicks > 0;
}

/** The newest of `keys` (YYYY-MM-DD keys compare in date order), or null. */
function newest(keys: string[]): string | null {
  return keys.length === 0 ? null : keys.reduce((a, b) => (b > a ? b : a));
}

/**
 * Current and previous totals. The current window ends on the newest day with
 * a number, not today: Google's numbers arrive days late, and may come first as
 * days with no value, which read as zero. Days after that end are not counted
 * yet. A day with no row counts as zero.
 *
 * The previous totals are given only when the history covers the whole previous
 * window, shown by a row on its first day (the job stores every day of each
 * span Google answered); a row older than that window says nothing about the
 * days inside it, so it neither counts nor turns the comparison on.
 */
export function summarizeListingMetrics(rows: ListingMetricRow[], windowDays: number): ListingMetricsSummary {
  const endDay =
    newest(rows.filter(hasNumber).map((row) => dayKey(row.day))) ?? newest(rows.map((row) => dayKey(row.day)));
  if (!endDay) return { endDay: null, current: null, previous: null };

  const currentStart = shiftDay(endDay, -(windowDays - 1));
  const previousStart = shiftDay(endDay, -(2 * windowDays - 1));

  const current = zero();
  const previous = zero();
  let covered = false;
  for (const row of rows) {
    const key = dayKey(row.day);
    if (key > endDay || key < previousStart) continue;
    if (key >= currentStart) {
      add(current, row);
    } else {
      add(previous, row);
      if (key === previousStart) covered = true;
    }
  }
  return { endDay, current, previous: covered ? previous : null };
}

/** "up 12", "down 3", "no change"; null without earlier data. */
export function describeListingChange(current: number, previous: number | null): string | null {
  if (previous === null) return null;
  const change = current - previous;
  if (change > 0) return `up ${formatNumber(change)}`;
  if (change < 0) return `down ${formatNumber(-change)}`;
  return "no change";
}
