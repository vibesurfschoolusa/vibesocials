import type { Platform } from "@prisma/client";

import { composerSubmitOutcome } from "@/lib/composerSubmitOutcome";
import { platformAcceptsMedia } from "@/lib/platformLimits";
import { nextFreeSlots, type PostingSlot } from "@/lib/postingSlots";
import { SCHEDULE_BUFFER_MS, toDateTimeLocalValue } from "@/lib/scheduling";
import type { YouTubePostMetadata } from "@/server/platforms/types";

/**
 * Pure rules for the Add-many page (/posts/bulk): how many files a batch takes,
 * how the rows get their times, which platforms each row goes to, and which rows
 * still need sending. Every file on that page is its own post.
 */

export const BULK_MAX_FILES = 20;

export const BULK_TOO_MANY_FILES_MESSAGE = `You can add up to ${BULK_MAX_FILES} posts at a time.`;
export const BULK_TIKTOK_NOTE =
  "TikTok posts need choices for each video. Add those one at a time on Create.";

// POST /api/posts refuses a blank caption ("baseCaption is required"), so the
// page refuses it first with a sentence that says what to do.
export const BULK_EMPTY_CAPTION_MESSAGE = "Write a caption for this post, then press the button again.";
export const BULK_NOT_UPLOADED_MESSAGE = "This file has not uploaded. Retry it or remove it.";
export const BULK_NO_PLATFORMS_MESSAGE =
  "None of the chosen platforms takes this kind of file. Choose another platform or remove it.";
export const BULK_NO_TIME_MESSAGE = "Pick a date and time for this post.";
export const BULK_PAST_TIME_MESSAGE = "Pick a time in the future.";
export const BULK_MAYBE_CREATED_MESSAGE =
  "This post may have been created. Check the Queue before sending it again.";
export const BULK_DRAFTS_NOTE = "Drafts are saved without a time. Set each one's time in the Queue.";
export const BULK_GOOGLE_BUTTON_NOTE =
  "Google posts get your workspace's default button, if one is set in Settings.";

/** How many of `picked` files fit in a batch that already has `current` rows. */
export function filesThatFit(current: number, picked: number): { take: number; tooMany: boolean } {
  const room = Math.max(0, BULK_MAX_FILES - current);
  return { take: Math.min(room, picked), tooMany: picked > room };
}

/** Tomorrow's local date as a date input value (`YYYY-MM-DD`). */
export function tomorrowLocalDate(now: Date): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);
  return toDateTimeLocalValue(tomorrow).slice(0, 10);
}

export interface BulkScheduleControls {
  /** Date input value, `YYYY-MM-DD`. */
  firstDay: string;
  /** Time input value, `HH:mm`. */
  timeOfDay: string;
  /** One post every this many days; a whole number of at least 1. */
  everyDays: number;
}

/**
 * `count` local date-times (`YYYY-MM-DDTHH:mm`, the datetime-local format),
 * one every `everyDays` days from `firstDay`, each at `timeOfDay`. Built from
 * calendar fields in the browser's zone, so a daylight-saving change keeps the
 * same wall-clock time. On the day the clocks go forward, a time that does not
 * exist that day (02:30 when 02:00 jumps to 03:00) becomes the next valid time
 * (03:30): that is what `new Date(y, m, d, h, min)` does, and it is tested.
 * Empty when the controls don't make a schedule.
 */
export function spreadSchedule(input: BulkScheduleControls & { count: number }): string[] {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.firstDay);
  const time = /^(\d{2}):(\d{2})$/.exec(input.timeOfDay);
  if (!day || !time || !Number.isInteger(input.everyDays) || input.everyDays < 1 || input.count < 1) {
    return [];
  }
  const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
  const [hours, minutes] = [Number(time[1]), Number(time[2])];
  return Array.from({ length: input.count }, (_, i) =>
    toDateTimeLocalValue(new Date(year, month, date + i * input.everyDays, hours, minutes)),
  );
}

interface TimeLockState {
  whenSetByHand: boolean;
  postId: string | null;
  uncertain: boolean;
}

/**
 * A row keeps its shown time when the user set it by hand, when its post was
 * created, or when its send got no clear answer: that post may be in the Queue
 * at the time it was sent with, and a moved time would send the user looking in
 * the wrong place and then pressing "Send again" for a second post.
 */
export function rowTimeLocked(row: TimeLockState): boolean {
  return row.whenSetByHand || row.postId !== null || row.uncertain;
}

/**
 * Give each row whose time is not locked (rowTimeLocked) the slot of its place
 * in the list. A locked row keeps its time (and its slot stays unused), so
 * changing one row never shifts the others. Rows are returned unchanged when
 * the controls are invalid.
 */
export function applySchedule<T extends { when: string } & TimeLockState>(
  rows: T[],
  controls: BulkScheduleControls,
): T[] {
  const slots = spreadSchedule({ ...controls, count: rows.length });
  if (slots.length !== rows.length) return rows;
  return rows.map((row, i) => (rowTimeLocked(row) || row.when === slots[i] ? row : { ...row, when: slots[i] }));
}

/**
 * "Use my posting times" (brief 11): give each row whose time is not locked
 * (rowTimeLocked) the next free posting slot, in list order. A locked row
 * keeps its time, and that time counts as taken, as do `taken` (the times the
 * workspace's posts hold). Rows past the free slots found keep their time.
 */
export function applySlotSchedule<T extends { when: string } & TimeLockState>(
  rows: T[],
  slots: readonly PostingSlot[],
  taken: readonly Date[],
  now: Date,
): T[] {
  const lockedTimes = rows
    .filter((row) => rowTimeLocked(row) && row.when)
    .map((row) => new Date(row.when))
    .filter((date) => !Number.isNaN(date.getTime()));
  const open = rows.filter((row) => !rowTimeLocked(row)).length;
  const free = nextFreeSlots(slots, [...taken, ...lockedTimes], now, open).map(toDateTimeLocalValue);
  let next = 0;
  return rows.map((row) => {
    if (rowTimeLocked(row)) return row;
    const when = free[next++];
    return when === undefined || row.when === when ? row : { ...row, when };
  });
}

/** Move the row with `id` up (-1) or down (+1) by one place. */
export function moveRow<T extends { id: string }>(rows: T[], id: string, delta: -1 | 1): T[] {
  const from = rows.findIndex((row) => row.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The chosen platforms this file goes to, and the ones it skips because they
 * don't take its kind of file. TikTok is never sent from this page (it needs
 * choices for each video), so it is neither sent nor listed as skipped.
 */
export function platformsForRow(
  selected: readonly Platform[],
  mimeType: string,
): { platforms: Platform[]; skipped: Platform[] } {
  const platforms: Platform[] = [];
  const skipped: Platform[] = [];
  for (const platform of selected) {
    if (platform === "tiktok") continue;
    (platformAcceptsMedia(platform, mimeType) ? platforms : skipped).push(platform);
  }
  return { platforms, skipped };
}

/** What deciding whether to send a row needs to know about it. */
export interface BulkSendableRow {
  id: string;
  /** The file is in storage. */
  uploaded: boolean;
  caption: string;
  /** From platformsForRow. */
  platforms: readonly Platform[];
  /** datetime-local value. */
  when: string;
  /** Set once POST /api/posts created this row's post; such a row is never sent again. */
  postId: string | null;
  /** The last send got no clear answer, so its post may exist; not sent until the user says so. */
  uncertain: boolean;
}

export type BulkFinishMode = "schedule" | "draft";

/**
 * Rows to send on a press: no post yet, and no send whose answer was unclear
 * (that post may exist; "Send again" clears the flag).
 */
export function rowsToSend<T extends { postId: string | null; uncertain: boolean }>(rows: T[]): T[] {
  return rows.filter((row) => row.postId === null && !row.uncertain);
}

export function allRowsCreated(rows: readonly { postId: string | null }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.postId !== null);
}

/**
 * Why this row can't be sent yet, or null when it can. `now` is the clock at
 * the press: a scheduled time must be SCHEDULE_BUFFER_MS ahead of it, the same
 * rule POST /api/posts applies (validateScheduledFor).
 */
export function rowSendBlock(row: BulkSendableRow, mode: BulkFinishMode, now: Date): string | null {
  if (!row.uploaded) return BULK_NOT_UPLOADED_MESSAGE;
  if (!row.caption.trim()) return BULK_EMPTY_CAPTION_MESSAGE;
  if (row.platforms.length === 0) return BULK_NO_PLATFORMS_MESSAGE;
  if (mode === "schedule") {
    const at = row.when ? new Date(row.when).getTime() : Number.NaN;
    if (Number.isNaN(at)) return BULK_NO_TIME_MESSAGE;
    if (at < now.getTime() + SCHEDULE_BUFFER_MS) return BULK_PAST_TIME_MESSAGE;
  }
  return null;
}

/** Stands for a response body that could not be read as JSON. */
export const UNREADABLE_BODY: unique symbol = Symbol("unreadable body");

export type BulkSendResponse = { threw: true } | { status: number; body: unknown };

export type BulkSendResult =
  | { outcome: "created"; postId: string; heldForApproval: boolean }
  | { outcome: "refused"; error: string }
  | { outcome: "unknown" };

/**
 * What one `POST /api/posts` did. The route creates the post before it
 * answers and takes no idempotency key, so an answer that never came, a 5xx,
 * or a body that can't be read may hide a post that exists: "unknown", never
 * resent on its own. A 4xx is a clear refusal (nothing was made) and keeps the
 * server's sentence, read as on Create (composerSubmitOutcome). A readable
 * success keeps its id, or a marker when it names none.
 */
export function classifySendResponse(response: BulkSendResponse, mode: BulkFinishMode): BulkSendResult {
  if ("threw" in response) return { outcome: "unknown" };
  const { status } = response;
  const readable = response.body !== UNREADABLE_BODY;
  if (status >= 400 && status < 500) {
    const outcome = composerSubmitOutcome({ ok: false, body: readable ? response.body : null, mode });
    return { outcome: "refused", error: outcome.toast };
  }
  if (status < 200 || status >= 300 || !readable) return { outcome: "unknown" };
  const outcome = composerSubmitOutcome({ ok: true, body: response.body, mode });
  const body = (typeof response.body === "object" && response.body !== null ? response.body : {}) as {
    postJob?: { id?: unknown } | null;
  };
  const id = body.postJob?.id;
  return {
    outcome: "created",
    postId: typeof id === "string" && id ? id : "created",
    heldForApproval: outcome.kind === "success" && outcome.heldForApproval,
  };
}

/** Earliest first day (today), as a date input `min`. */
export function minFirstDay(now: Date): string {
  return toDateTimeLocalValue(now).slice(0, 10);
}

/** Earliest row time, as a datetime-local `min`: now plus the buffer, up to the next whole minute. */
export function minRowTime(now: Date): string {
  const earliest = new Date(now.getTime() + SCHEDULE_BUFFER_MS);
  if (earliest.getSeconds() > 0 || earliest.getMilliseconds() > 0) {
    earliest.setSeconds(60, 0);
  }
  return toDateTimeLocalValue(earliest);
}

/**
 * The new default first day when the page has stayed open past midnight, or
 * null when it should stay (still tomorrow, or the user picked it).
 */
export function refreshedFirstDay(state: { firstDay: string; setByUser: boolean }, now: Date): string | null {
  if (state.setByUser) return null;
  const tomorrow = tomorrowLocalDate(now);
  return state.firstDay === tomorrow ? null : tomorrow;
}

/** The Create page's starting YouTube privacy. */
export const BULK_YOUTUBE_PRIVACY_DEFAULT: YouTubePostMetadata["privacyStatus"] = "unlisted";

/** One YouTube privacy choice is shown when YouTube is chosen and a row is a video. */
export function youtubePrivacyShown(selected: readonly Platform[], mimeTypes: readonly string[]): boolean {
  return selected.includes("youtube") && mimeTypes.some((type) => platformAcceptsMedia("youtube", type));
}

export type BulkUploadStatus = "queued" | "working" | "done" | "failed";
export type BulkCaptionStatus = "waiting" | "writing" | "done" | "failed";

interface WorkState {
  id: string;
  upload: BulkUploadStatus;
  caption: BulkCaptionStatus;
}

/**
 * The next upload or caption to run, or null. One thing at a time, in list
 * order: a row is uploaded and captioned before the next row starts, and
 * nothing starts while something is in progress.
 */
export function nextWork(rows: readonly WorkState[]): { id: string; step: "upload" | "caption" } | null {
  if (rows.some((row) => row.upload === "working" || row.caption === "writing")) return null;
  for (const row of rows) {
    if (row.upload === "queued") return { id: row.id, step: "upload" };
    if (row.upload === "done" && row.caption === "waiting") return { id: row.id, step: "caption" };
  }
  return null;
}

/** "Writing captions, 3 of 20" while any caption is still to come, else null. */
export function captionProgressText(rows: readonly WorkState[]): string | null {
  const counted = rows.filter((row) => row.upload !== "failed");
  const pending = counted.some((row) => row.caption === "waiting" || row.caption === "writing");
  if (!pending) return null;
  const finished = counted.filter((row) => row.caption === "done" || row.caption === "failed").length;
  return `Writing captions, ${finished} of ${counted.length}`;
}
