import type { PostJobDTO } from "./postsDto";

/**
 * Client-side "Load more" pagination helpers (activity pagination, Task C2).
 *
 * Pure list transforms shared by `usePostJobs` (the activity feed's background
 * poll + Load more) and the Queue view (its own status-filtered Load more), so
 * both agree on the one non-negotiable invariant: the rendered list NEVER holds
 * two rows with the same `id` (React key collision). Kept framework-free in a
 * lib module so they unit-test in the repo's node environment without a render
 * harness — the same discipline as `hasWorkInFlight` and the cursor helpers.
 */

/**
 * De-duplicate by `id`, keeping the FIRST occurrence of each id and otherwise
 * preserving order. The "first wins" rule is deliberate: callers place the copy
 * they want to survive (the fresher / already-on-screen one) earlier in the
 * input.
 */
export function dedupeJobsById(jobs: PostJobDTO[]): PostJobDTO[] {
  const seen = new Set<string>();
  const out: PostJobDTO[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
  }
  return out;
}

/**
 * Append a freshly-fetched OLDER page (from a `?cursor=` request) beneath the
 * rows already on screen, dropping any id already present. Existing rows come
 * first, so `dedupeJobsById`'s first-wins rule keeps the on-screen copy: a
 * background poll can prepend a row that the older page also carries, and this
 * guarantees the merged list still has no duplicate key.
 */
export function appendJobsPage(existing: PostJobDTO[], page: PostJobDTO[]): PostJobDTO[] {
  return dedupeJobsById([...existing, ...page]);
}

/**
 * Merge a freshly-polled page 1 over the currently-loaded list for a background
 * refresh: page-1 rows first (in server order, so their statuses stay fresh),
 * then every previously-loaded row whose id is NOT on page 1 — i.e. the older
 * tail the user pulled in via Load more, preserved in place. Because the tail
 * excludes every page-1 id, no row is duplicated (a shared row keeps only its
 * fresh page-1 copy).
 *
 * Spec §C — ACCEPTED deep-tail staleness: the poll only re-fetches page 1, so
 * rows below it (loaded via Load more) are not refreshed and their statuses can
 * drift until a manual reload resets pagination to a fresh page 1. Re-fetching
 * the entire loaded range every poll is deliberately out of scope; the poll's
 * job is to keep the freshest (newest) rows current, and a settling job is
 * almost always on page 1 anyway.
 *
 * When no tail has been loaded (prev ⊆ page 1), the result equals page 1
 * exactly — so the pre-pagination "replace with fresh page 1" poll behavior is
 * unchanged for callers who never clicked Load more.
 */
export function mergePolledPageOne(pageOne: PostJobDTO[], prev: PostJobDTO[]): PostJobDTO[] {
  const pageOneIds = new Set(pageOne.map((job) => job.id));
  const tail = prev.filter((job) => !pageOneIds.has(job.id));
  return [...pageOne, ...tail];
}
