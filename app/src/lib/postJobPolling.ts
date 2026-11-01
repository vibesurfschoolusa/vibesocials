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
