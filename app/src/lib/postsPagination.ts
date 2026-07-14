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
  // An empty page 1 ⇒ the workspace is truly empty (the poll re-fetched the
  // newest page and it came back with zero jobs). Any retained tail (rows pulled
  // in via Load more) is therefore stale and must NOT survive — return the empty
  // page as-is. This restores main's clear-on-empty poll behavior (pre-pagination
  // an empty poll replaced the list); keeping `prev` here would strand deleted
  // rows on screen. Returning the `pageOne` reference also keeps the "no tail ⇒
  // result is page 1" invariant intact for the empty case.
  if (pageOne.length === 0) return pageOne;
  const pageOneIds = new Set(pageOne.map((job) => job.id));
  const tail = prev.filter((job) => !pageOneIds.has(job.id));
  // Defensive symmetry with appendJobsPage: dedupe the composed result so a prev
  // that somehow repeats a tail row (off page 1) cannot surface a duplicate id
  // (React key collision). The tail already excludes every page-1 id, so this
  // only ever collapses accidental repeats within the tail itself.
  return dedupeJobsById([...pageOne, ...tail]);
}
