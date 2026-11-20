/**
 * R40 client-journey L2/L3: one "limit reached" view for every client link
 * (/c's choice, /v's list, /v's report). The network limit's 429 lasts its
 * clock hour, so a Try again pressed now fails again with the same sentence:
 * the page shows no button and one instruction, built from the answer's wait.
 * When the wait outlasts what the page is waiting for (the /c choice ends
 * after 15 minutes), reloading can't work, so the instruction names the step
 * that does.
 */

import { CONNECT_LINK_USED_TOO_OFTEN_REASON } from "./connectLink";
import { REVIEW_LINK_DAILY_LIMIT_MESSAGE, REVIEW_LINK_DAILY_LIMIT_REASON } from "./reviewLink";

/** The routes' reason; their own 429 sentences start with it (tested). */
export const CLIENT_LINK_LIMIT_REASON = "Too many requests from this network in the last hour.";

function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

function minutesText(seconds: number): string {
  const minutes = wholeMinutes(seconds);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * R41 client-journey L3: the time a reload needs after the printed wait, so
 * the client can still reload and press before what is waited for ends.
 */
const RELOAD_MARGIN_SECONDS = 60;

/**
 * The one instruction under a 429. `outlasts`: what the page waits for lives
 * `lifeSeconds` at most. The wait is compared as printed (whole minutes,
 * rounded up) plus `marginSeconds` (the reload margin unless given); one at
 * least that long says to wait, then `then`. R41 review: a `then` that
 * claims the thing has ended by itself passes 0, so it is said only when true.
 */
export function limitReachedSentence(
  waitSeconds: number | undefined,
  outlasts?: { lifeSeconds: number; then: string; marginSeconds?: number },
): string {
  if (!waitSeconds || waitSeconds <= 0) return `${CLIENT_LINK_LIMIT_REASON} Reload this page later.`;
  const margin = outlasts?.marginSeconds ?? RELOAD_MARGIN_SECONDS;
  if (outlasts && wholeMinutes(waitSeconds) * 60 + margin >= outlasts.lifeSeconds) {
    return `${CLIENT_LINK_LIMIT_REASON} Wait ${minutesText(waitSeconds)}, then ${outlasts.then}`;
  }
  return `${CLIENT_LINK_LIMIT_REASON} Reload this page in ${minutesText(waitSeconds)}.`;
}

/** The network window is a clock hour, so no wait known is at most an hour. */
export const CLIENT_LINK_LIMIT_WINDOW_SECONDS = 3600;

/**
 * R41 review: /v turns its decisions back on by itself when the wait ends,
 * so the sentence names the wait and no reload step (a reload would empty
 * what is typed).
 */
export function sendAgainSentence(waitSeconds: number | undefined): string {
  const wait = waitSeconds && waitSeconds > 0 ? waitSeconds : CLIENT_LINK_LIMIT_WINDOW_SECONDS;
  return `${CLIENT_LINK_LIMIT_REASON} You can send again in ${minutesText(wait)}.`;
}

/**
 * R41 lead: the /v link's daily decision limit, the same view. Its wait can
 * be most of a day, so from an hour on it is named in whole hours, rounded up;
 * with no wait known, the route's own "Try again tomorrow."
 */
export function dailyLimitSentence(waitSeconds: number | undefined): string {
  if (!waitSeconds || waitSeconds <= 0) return REVIEW_LINK_DAILY_LIMIT_MESSAGE;
  const hours = Math.ceil(waitSeconds / 3600);
  const wait = waitSeconds < 3600 ? minutesText(waitSeconds) : hours === 1 ? "1 hour" : `${hours} hours`;
  return `${REVIEW_LINK_DAILY_LIMIT_REASON} Reload this page in ${wait}.`;
}

/**
 * The codes the /c start route sends the visitor back with when a limit
 * refuses a press, or (R46 pages-a L1) couldn't be checked.
 */
export const CONNECT_LIMIT_CODES = {
  network: "rate_limited",
  link: "used_too_often",
  unchecked: "limit_unchecked",
} as const;

/** LIMIT_UNCHECKED_MESSAGE's reason, before its wait (tested). */
export const LIMIT_UNCHECKED_REASON = "We couldn't check that just now. Nothing was changed.";

/** The wait a limit that couldn't be checked asks for (the route's Retry-After). */
export const LIMIT_UNCHECKED_WAIT_SECONDS = 60;

/** Where the start route sends a refused press back to: the code, the wait's end and the platform. */
export function connectAgainQuery(
  code: (typeof CONNECT_LIMIT_CODES)[keyof typeof CONNECT_LIMIT_CODES],
  waitSeconds: number,
  nowMs: number,
): { error: string; until: string } {
  // The sentence rounds what is left up to whole minutes; rounding the press time up as well
  // would make a minute's wait read "2 minutes" (R46 review).
  return { error: code, until: String(Math.floor(nowMs / 1000) + Math.ceil(waitSeconds)) };
}

/**
 * R45 pages-a L7: the sentence on /c after the start route refused a Connect
 * press for a limit (a plain form post, so it comes back with `?error=` in the
 * address). R46 client-journey L1: the address carries the wait's end
 * (`?until=`, epoch seconds), not the wait, so a reload or Back much later
 * reads what is left by `nowMs` (the server's request time); once the end has
 * passed, only the step is left. The end is typed text: anything but whole
 * seconds no more than the hour the limits count ahead is "up to an hour" (a
 * minute for a limit that couldn't be checked). `button` is the row's own;
 * `platform` its label, or null when the press named none. Null for any other
 * code.
 */
export function connectAgainSentence(
  code: string | null,
  until: string | null,
  button: string,
  platform: string | null,
  nowMs: number,
): string | null {
  const reason =
    code === CONNECT_LIMIT_CODES.network
      ? CLIENT_LINK_LIMIT_REASON
      : code === CONNECT_LIMIT_CODES.link
        ? CONNECT_LINK_USED_TOO_OFTEN_REASON
        : code === CONNECT_LIMIT_CODES.unchecked
          ? LIMIT_UNCHECKED_REASON
          : null;
  if (!reason) return null;
  const target = `${button}${platform ? ` beside ${platform}` : ""}`;
  const end = until !== null && /^\d{1,12}$/.test(until) ? Number(until) : null;
  const left = end === null ? null : end - nowMs / 1000;
  if (left !== null && left <= 0) return `Press ${target} again.`;
  const waitText =
    left !== null && left <= CLIENT_LINK_LIMIT_WINDOW_SECONDS
      ? `Wait ${minutesText(left)}`
      : code === CONNECT_LIMIT_CODES.unchecked
        ? "Wait a minute"
        : "Wait up to an hour";
  return `${reason} ${waitText}, then press ${target} again.`;
}

/** The wait a 429 names: the body's `retryAfterSeconds`, else the Retry-After header. */
export function limitWaitSeconds(response: Response, data: unknown): number | undefined {
  const fromBody = (data as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : undefined;
}
