import type { Platform } from "@prisma/client";

import { composerSubmitOutcome } from "@/lib/composerSubmitOutcome";
import { platformAcceptsMedia } from "@/lib/platformLimits";
import { toDateTimeLocalValue } from "@/lib/scheduling";

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
 * same wall-clock time. Empty when the controls don't make a schedule.
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

/**
 * Give each row not set by hand the slot of its place in the list. A hand-set
 * row keeps its own time (and its slot stays unused), so changing one row never
 * shifts the others. Rows are returned unchanged when the controls are invalid.
 */
export function applySchedule<T extends { when: string; whenSetByHand: boolean }>(
  rows: T[],
  controls: BulkScheduleControls,
): T[] {
  const slots = spreadSchedule({ ...controls, count: rows.length });
  if (slots.length !== rows.length) return rows;
  return rows.map((row, i) => (row.whenSetByHand || row.when === slots[i] ? row : { ...row, when: slots[i] }));
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
}

export type BulkFinishMode = "schedule" | "draft";

/** Rows whose post doesn't exist yet: new rows and rows the server refused before. */
export function rowsToSend<T extends { postId: string | null }>(rows: T[]): T[] {
  return rows.filter((row) => row.postId === null);
}

export function allRowsCreated(rows: readonly { postId: string | null }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.postId !== null);
}

/** Why this row can't be sent yet, or null when it can. */
export function rowSendBlock(row: BulkSendableRow, mode: BulkFinishMode): string | null {
  if (!row.uploaded) return BULK_NOT_UPLOADED_MESSAGE;
  if (!row.caption.trim()) return BULK_EMPTY_CAPTION_MESSAGE;
  if (row.platforms.length === 0) return BULK_NO_PLATFORMS_MESSAGE;
  if (mode === "schedule" && !row.when) return BULK_NO_TIME_MESSAGE;
  return null;
}

export type BulkSendResult =
  | { created: true; postId: string; heldForApproval: boolean }
  | { created: false; error: string };

/**
 * A `POST /api/posts` response, read the same way as on Create
 * (composerSubmitOutcome). A post that exists keeps an id even when the body
 * names none, so pressing the button again never sends it twice.
 */
export function sendResultFromResponse(input: { ok: boolean; body: unknown; mode: BulkFinishMode }): BulkSendResult {
  const outcome = composerSubmitOutcome(input);
  if (!outcome.resetForm) return { created: false, error: outcome.toast };
  const body = (typeof input.body === "object" && input.body !== null ? input.body : {}) as {
    postJob?: { id?: unknown } | null;
    postJobId?: unknown;
  };
  const id = body.postJob?.id ?? body.postJobId;
  return {
    created: true,
    postId: typeof id === "string" && id ? id : "created",
    heldForApproval: outcome.kind === "success" && outcome.heldForApproval,
  };
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
