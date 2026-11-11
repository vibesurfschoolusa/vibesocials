/**
 * Posting times (2026-11-10): the workspace's usual weekly times to post, and
 * the next of them no post holds yet. A slot is a weekday and a wall-clock
 * time, read in the viewer's own time zone; the browser turns it into dates.
 */

export interface PostingSlot {
  /** 0 = Sunday … 6 = Saturday, as `Date.getDay()`. */
  day: number;
  /** `HH:MM`, 24-hour. */
  time: string;
}

export const MAX_POSTING_SLOTS = 21;

/** A slot is offered only this far ahead of now, so there is time to finish the post. */
export const SLOT_LEAD_MS = 10 * 60 * 1000;

/** A post within this of a slot holds it. */
export const SLOT_TAKEN_WITHIN_MS = 5 * 60 * 1000;

/**
 * How far ahead the search goes. Taken times are read 90 days ahead, so
 * after that every slot is free and the search ends quickly; this bound only
 * stops a loop on a list that could never fill.
 */
const SEARCH_DAYS = 400;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type PostingSlotsValidation = { ok: true; slots: PostingSlot[] } | { ok: false; error: string };

/**
 * Check and tidy posting times from a request: each entry a weekday 0..6 and
 * an `HH:MM` time; sorted by weekday then time, duplicates dropped, at most
 * MAX_POSTING_SLOTS after that. `null` clears them.
 */
export function normalizePostingSlots(value: unknown): PostingSlotsValidation {
  if (value === null) return { ok: true, slots: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: "Posting times must be a list of weekdays and times." };
  }
  const seen = new Set<string>();
  const slots: PostingSlot[] = [];
  for (const entry of value) {
    const { day, time } = (typeof entry === "object" && entry !== null ? entry : {}) as {
      day?: unknown;
      time?: unknown;
    };
    if (
      typeof day !== "number" ||
      !Number.isInteger(day) ||
      day < 0 ||
      day > 6 ||
      typeof time !== "string" ||
      !TIME_PATTERN.test(time)
    ) {
      return { ok: false, error: "Each posting time needs a weekday and a time like 09:30." };
    }
    const key = `${day} ${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ day, time });
  }
  if (slots.length > MAX_POSTING_SLOTS) {
    return {
      ok: false,
      error: `You can save up to ${MAX_POSTING_SLOTS} posting times. Remove some, then save again.`,
    };
  }
  slots.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
  return { ok: true, slots };
}

/** The saved times from the stored column; none when it is missing or not a valid list. */
export function readPostingSlots(stored: unknown): PostingSlot[] {
  if (stored == null) return [];
  const result = normalizePostingSlots(stored);
  return result.ok ? result.slots : [];
}

/**
 * The next `count` slot times after `now` that no post holds, earliest first.
 * Runs in the browser: each slot becomes `new Date(year, month, day, hours,
 * minutes)` on its weekday, so a daylight-saving change keeps the wall-clock
 * time. A slot less than SLOT_LEAD_MS ahead is skipped, and so is one with a
 * `taken` time within SLOT_TAKEN_WITHIN_MS of it.
 */
export function nextFreeSlots(
  slots: readonly PostingSlot[],
  taken: readonly Date[],
  now: Date,
  count: number,
): Date[] {
  if (slots.length === 0 || count < 1) return [];
  const takenMs = taken.map((date) => date.getTime());
  const earliest = now.getTime() + SLOT_LEAD_MS;
  const times = slots
    .map((slot) => ({ day: slot.day, match: TIME_PATTERN.exec(slot.time) }))
    .filter((slot): slot is { day: number; match: RegExpExecArray } => slot.match !== null)
    .map((slot) => ({ day: slot.day, hours: Number(slot.match[1]), minutes: Number(slot.match[2]) }))
    .sort((a, b) => a.hours - b.hours || a.minutes - b.minutes);

  const found: Date[] = [];
  const [year, month, date] = [now.getFullYear(), now.getMonth(), now.getDate()];
  for (let offset = 0; offset < SEARCH_DAYS && found.length < count; offset++) {
    const weekday = new Date(year, month, date + offset).getDay();
    for (const slot of times) {
      if (slot.day !== weekday) continue;
      const candidate = new Date(year, month, date + offset, slot.hours, slot.minutes);
      const at = candidate.getTime();
      if (at < earliest) continue;
      if (takenMs.some((t) => Math.abs(t - at) <= SLOT_TAKEN_WITHIN_MS)) continue;
      found.push(candidate);
      if (found.length === count) break;
    }
  }
  return found;
}
