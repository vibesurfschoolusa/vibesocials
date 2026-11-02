import type { PostJobDTO } from "./postsDto";

/**
 * Pure decisions behind `usePostJobs`' background poll, kept framework-free so
 * they unit-test in the repo's node environment (no render harness).
 */

/** True when a single job has work in flight (a running publish or a pending result). */
function isJobInFlight(job: PostJobDTO): boolean {
  return job.status === "in_progress" || job.results.some((result) => result.status === "pending");
}

/**
 * Copy the feed shows once polling has given up (`nextPollDelayMs` returned
 * null) while work is still in flight. One constant so the Activity view and the
 * dashboard's recent-activity list can never drift apart.
 */
export const POLLING_STOPPED_HINT = "Still processing — refresh to check for updates.";

/**
 * 2026-11-01 scale audit (W5): the feed used to poll every 10 s with no backoff,
 * for as long as any job stayed in flight. The schedule is now a backoff keyed
 * on how long the current run of polling has been going: every 10 s for the
 * first 2 minutes, every 30 s until 10 minutes, every 60 s until 30 minutes,
 * then it stops. Each stage is `[exclusive upper bound of elapsed ms, delay ms]`.
 */
const POLL_STAGES: ReadonlyArray<readonly [untilMs: number, delayMs: number]> = [
  [120_000, 10_000],
  [600_000, 30_000],
  [1_800_000, 60_000],
];

/**
 * Delay before the next background poll, given how long (ms) the current run of
 * polling has been going; `null` once the schedule has run out and polling
 * should stop. The run's clock starts when polling starts and restarts when a
 * job newly enters the in-flight set (see `hasNewInFlightJob`).
 */
export function nextPollDelayMs(elapsedMs: number): number | null {
  for (const [untilMs, delayMs] of POLL_STAGES) {
    if (elapsedMs < untilMs) return delayMs;
  }
  return null;
}

/** What a poll trigger should do right now. */
export type PollAction = "fetch" | "skip" | "stop";

/**
 * Decide what the hook's timer tick (`"timer"`) or `visibilitychange` listener
 * (`"visibility"`) should do. `hidden` is `document.visibilityState === "hidden"`.
 *
 * - Hidden tab: always `"skip"`. A hidden tab never fetches and never advances
 *   to `"stop"`; elapsed time keeps counting meanwhile, so a returning user is
 *   handled by the `"visibility"` case below rather than finding polling dead.
 * - Visible tab, `"visibility"`: `"fetch"` immediately, whatever the elapsed
 *   time, so a user returning to the tab sees fresh state with no wait for the
 *   next tick (the re-arm after that fetch then stops the schedule if it has
 *   run out).
 * - Visible tab, `"timer"`: `"fetch"` while the schedule has time left, else
 *   `"stop"`.
 */
export function decidePollAction(
  trigger: "timer" | "visibility",
  elapsedMs: number,
  hidden: boolean,
): PollAction {
  if (hidden) return "skip";
  if (trigger === "visibility") return "fetch";
  return nextPollDelayMs(elapsedMs) === null ? "stop" : "fetch";
}

/**
 * Ids of everything the poll is waiting on: jobs the fetched data shows in
 * flight, plus accepted retries still being watched.
 */
export function inFlightJobIds(
  jobs: PostJobDTO[] | null,
  retryWatch: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>(retryWatch);
  for (const job of jobs ?? []) {
    if (isJobInFlight(job)) ids.add(job.id);
  }
  return ids;
}

/**
 * True when `current` holds a job id that `previous` did not - a new publish, a
 * retry, or a watch added by `watchRetry`. That is the event that restarts the
 * backoff schedule from 0; jobs merely leaving the set do not.
 */
export function hasNewInFlightJob(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): boolean {
  for (const id of current) {
    if (!previous.has(id)) return true;
  }
  return false;
}

/**
 * True while any job has work in flight — a fresh publish still running, or a
 * retried result the server has marked pending.
 */
export function hasWorkInFlight(jobs: PostJobDTO[] | null): boolean {
  return jobs?.some(isJobInFlight) ?? false;
}

/**
 * Should the activity/dashboard feed keep polling `GET /api/posts`?
 *
 * Yes while the fetched data shows work in flight (`hasWorkInFlight`), AND
 * while an accepted retry is still being watched (`retryWatch` — job ids whose
 * "Retry <platform>" request succeeded and whose terminal state we have not
 * yet seen). The second clause is the 2026-11-01 audit fix: the list a retry
 * was clicked in shows the job as `failed`, so `hasWorkInFlight` alone is false
 * and the card was left on "Retrying…" with no poll to ever update it.
 */
export function shouldPollPostJobs(
  jobs: PostJobDTO[] | null,
  retryWatch: ReadonlySet<string>,
): boolean {
  return hasWorkInFlight(jobs) || retryWatch.size > 0;
}

/**
 * Drop watched job ids that freshly fetched server data has settled, so the
 * poll can stop. A watched job is settled when page 1 carries it and it is no
 * longer in flight (finished, or failed again — the card then shows the new
 * outcome), or when page 1 doesn't carry it at all (a row loaded further down
 * via Load more can't be observed by the page-1 poll; watching it would poll
 * forever).
 *
 * Returns the SAME set instance when nothing changed, so a state setter fed
 * this function bails out instead of re-rendering.
 */
export function settleRetryWatch(
  watch: ReadonlySet<string>,
  freshJobs: PostJobDTO[],
): ReadonlySet<string> {
  if (watch.size === 0) return watch;
  const byId = new Map(freshJobs.map((job) => [job.id, job]));
  const next = new Set<string>();
  for (const id of watch) {
    const job = byId.get(id);
    if (job && isJobInFlight(job)) next.add(id);
  }
  return next.size === watch.size ? watch : next;
}
