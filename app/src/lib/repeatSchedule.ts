import { validateScheduledFor } from "@/lib/scheduling";

/**
 * Repeat posts (2026-11-10): the dates a repeating post is created for, worked
 * out in the browser from the first date's local calendar fields, and the
 * server's check of the instants it receives. A series is just ordinary
 * scheduled posts; nothing here runs later.
 */

export type RepeatInterval = "weekly" | "biweekly" | "monthly";

/** Posts in a series, the first included. */
export const REPEAT_MIN_COUNT = 2;
export const REPEAT_MAX_COUNT = 12;
export const REPEAT_DEFAULT_COUNT = 4;

/**
 * Consecutive posts of a series must be at least this far apart. A day less
 * an hour, so a weekly 9:00 still passes on the night the clocks go back.
 */
export const REPEAT_MIN_GAP_MS = 23 * 60 * 60 * 1000;

export const REPEAT_STORY_MESSAGE = "A Story cannot repeat.";
export const REPEAT_X_NOTE =
  "X refuses a post whose text is the same as a recent one. Change the text of repeats in the Queue if X refuses them.";

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * `count` dates from `first` (included) at `interval`. Built with
 * `new Date(year, month, day, hours, minutes)` in the browser's zone, so 9:00
 * stays 9:00 across a daylight-saving change. Monthly keeps the first date's
 * day of the month; a month without that day (the 31st) gets its last day,
 * and the next month with it gets the original day back. Empty for a count
 * outside REPEAT_MIN_COUNT to REPEAT_MAX_COUNT or an invalid date.
 */
export function repeatSchedule(first: Date, interval: RepeatInterval, count: number): Date[] {
  if (
    Number.isNaN(first.getTime()) ||
    !Number.isInteger(count) ||
    count < REPEAT_MIN_COUNT ||
    count > REPEAT_MAX_COUNT
  ) {
    return [];
  }
  const [year, month, day] = [first.getFullYear(), first.getMonth(), first.getDate()];
  const [hours, minutes] = [first.getHours(), first.getMinutes()];
  return Array.from({ length: count }, (_, i) => {
    if (interval === "monthly") {
      const target = new Date(year, month + i, 1);
      const lastDay = daysInMonth(target.getFullYear(), target.getMonth());
      return new Date(target.getFullYear(), target.getMonth(), Math.min(day, lastDay), hours, minutes);
    }
    const step = interval === "weekly" ? 7 : 14;
    return new Date(year, month, day + i * step, hours, minutes);
  });
}

export type RepeatAtValidation = { ok: true; dates: Date[] } | { ok: false; error: string };

/**
 * Check `repeatAt` from `POST /api/posts`: 1 to REPEAT_MAX_COUNT - 1 instants,
 * each a valid future time (validateScheduledFor), each later than the one
 * before it (the first post's `first` included) by at least REPEAT_MIN_GAP_MS.
 * The error names the repeat that failed, counted from 1.
 */
export function validateRepeatAt(value: unknown, first: Date, now: Date): RepeatAtValidation {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `repeatAt must be a list of 1 to ${REPEAT_MAX_COUNT - 1} dates and times.` };
  }
  if (value.length > REPEAT_MAX_COUNT - 1) {
    return {
      ok: false,
      error: `A post can repeat at most ${REPEAT_MAX_COUNT} times in total. Choose fewer repeats.`,
    };
  }
  const dates: Date[] = [];
  let previous = first;
  for (const [index, raw] of value.entries()) {
    const label = `Repeat ${index + 1}`;
    const checked = validateScheduledFor(raw, now);
    if (!checked.ok) {
      const isPast = typeof raw === "string" && !Number.isNaN(new Date(raw).getTime());
      return {
        ok: false,
        error: isPast
          ? `${label} must be at least a minute in the future.`
          : `${label} is not a valid date and time.`,
      };
    }
    if (checked.date.getTime() <= previous.getTime()) {
      return { ok: false, error: `${label} must be later than the one before it.` };
    }
    if (checked.date.getTime() - previous.getTime() < REPEAT_MIN_GAP_MS) {
      return {
        ok: false,
        error: `${label} is less than 23 hours after the one before it. Space the repeats at least a day apart.`,
      };
    }
    dates.push(checked.date);
    previous = checked.date;
  }
  return { ok: true, dates };
}
