/**
 * Queue calendar — pure date math for the month view (no Date.now(), no DOM).
 * All "days" are BROWSER-LOCAL dates keyed "YYYY-MM-DD", matching how the
 * queue already displays times (localTimeZoneLabel()). Weeks start Sunday.
 */

export interface CalendarDay {
  key: string;
  dayOfMonth: number;
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toCalendarDay(date: Date, monthIndex: number): CalendarDay {
  return {
    key: localDayKey(date),
    dayOfMonth: date.getDate(),
    inMonth: date.getMonth() === monthIndex,
  };
}

/** Sunday-start weeks covering the given month, padded with adjacent days. */
export function buildCalendarMonth(year: number, monthIndex: number): CalendarDay[][] {
  const first = new Date(year, monthIndex, 1);
  const start = new Date(year, monthIndex, 1 - first.getDay());
  const weeks: CalendarDay[][] = [];
  const cursor = new Date(start);
  do {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(toCalendarDay(cursor, monthIndex));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === monthIndex);
  return weeks;
}

/** Scheduled jobs grouped by local day key, each day's list sorted by time. */
export function groupJobsByDay<T extends { scheduledFor: string | null }>(
  jobs: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const job of jobs) {
    if (!job.scheduledFor) continue;
    const key = localDayKey(new Date(job.scheduledFor));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(job);
    else grouped.set(key, [job]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort(
      (a, b) => new Date(a.scheduledFor!).getTime() - new Date(b.scheduledFor!).getTime(),
    );
  }
  return grouped;
}

/**
 * Drop rule for drag-to-reschedule: keep the post's local time-of-day, move it
 * to `dayKey`. Returns the new ISO string, or null when the day key is
 * malformed or the resulting instant is less than `now + bufferMs` away
 * (past days, and same-day moves whose time already passed) — the caller
 * shows a toast instead of clamping.
 */
export function retargetSchedule(
  originalIso: string,
  dayKey: string,
  now: Date,
  bufferMs: number,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const original = new Date(originalIso);
  if (Number.isNaN(original.getTime())) return null;
  const target = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    original.getHours(),
    original.getMinutes(),
    original.getSeconds(),
    original.getMilliseconds(),
  );
  if (target.getTime() < now.getTime() + bufferMs) return null;
  return target.toISOString();
}
