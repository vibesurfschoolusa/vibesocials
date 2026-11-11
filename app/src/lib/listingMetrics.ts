/**
 * The Google listing card's sums (2026-11-10). Pure: the route reads the rows
 * of LocationMetricDaily for one workspace and location and hands them here.
 */

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
  /** The newest stored day (YYYY-MM-DD), the end of the current window; null with no rows. */
  endDay: string | null;
  /** The `windowDays` days ending on endDay; null with no rows. */
  current: ListingMetricTotals | null;
  /** The `windowDays` days before those; null when nothing is stored before the current window. */
  previous: ListingMetricTotals | null;
}

const DAY_MS = 86_400_000;

function dayKey(day: Date | string): string {
  return typeof day === "string" ? day.slice(0, 10) : day.toISOString().slice(0, 10);
}

function shift(key: string, days: number): string {
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

/**
 * Current and previous totals. The current window ends on the newest stored
 * day, not today: Google's numbers arrive days late, and ending on today would
 * make the current window look short. A day with no row counts as zero.
 */
export function summarizeListingMetrics(rows: ListingMetricRow[], windowDays: number): ListingMetricsSummary {
  if (rows.length === 0) return { endDay: null, current: null, previous: null };

  // YYYY-MM-DD keys compare in date order.
  const endDay = rows.map((row) => dayKey(row.day)).reduce((a, b) => (b > a ? b : a));
  const currentStart = shift(endDay, -(windowDays - 1));
  const previousStart = shift(endDay, -(2 * windowDays - 1));

  const current = zero();
  const previous = zero();
  let earlier = false;
  for (const row of rows) {
    const key = dayKey(row.day);
    if (key >= currentStart) {
      add(current, row);
    } else {
      earlier = true;
      if (key >= previousStart) add(previous, row);
    }
  }
  return { endDay, current, previous: earlier ? previous : null };
}

/** "up 12", "down 3", "no change"; null without earlier data. */
export function describeListingChange(current: number, previous: number | null): string | null {
  if (previous === null) return null;
  const change = current - previous;
  if (change > 0) return `up ${change}`;
  if (change < 0) return `down ${-change}`;
  return "no change";
}
