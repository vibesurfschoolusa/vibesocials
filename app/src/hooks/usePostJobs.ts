"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import { settleRetryWatch, shouldPollPostJobs } from "@/lib/postJobPolling";
import { appendJobsPage, mergePolledPageOne } from "@/lib/postsPagination";

export interface UsePostJobsResult {
  jobs: PostJobDTO[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /**
   * Team Workspaces (Task 7) — total members in the caller's active
   * workspace, straight from `PostsResponse.workspaceMemberCount`. `null`
   * until the first successful load. Consumers gate the `by {name}`
   * attribution on `PostJobCard` with `(workspaceMemberCount ?? 0) > 1`
   * (design doc §7 — a solo workspace's activity feed looks unchanged).
   */
  workspaceMemberCount: number | null;
  /**
   * Activity pagination (Task C2) — fetch the next (older) page via the last
   * response's `nextCursor` and APPEND it, de-duplicated by id. A no-op while a
   * page is already loading or when `hasMore` is false. Never flips
   * `loading`/`error`: a failed Load more keeps the current list on screen and
   * leaves the button in place for a retry.
   */
  loadMore: () => void;
  /** True while a `loadMore()` fetch is in flight — drives the button spinner. */
  loadingMore: boolean;
  /**
   * True while the last successful load reported a `nextCursor` (an older page
   * exists). Gates the Load more button; the background poll never changes it,
   * so the loaded tail's cursor survives a refresh.
   */
  hasMore: boolean;
  /**
   * 2026-11-01 audit — call after a "Retry <platform>" request has been
   * ACCEPTED for `jobId`. Refetches right away and keeps polling until the
   * fetched data shows that job terminal, so the card leaves "Retrying…" even
   * though the list it was clicked in showed the job as settled (nothing in
   * flight → no poll). See `shouldPollPostJobs` / `settleRetryWatch`.
   */
  watchRetry: (jobId: string) => void;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Fetches the current user's post jobs from `GET /api/posts`. Shared by the
 * dashboard's recent-activity preview and the full activity view.
 *
 * Task 8 — polls every 10s while `shouldPollPostJobs` is true (a fresh publish
 * or a retry still running, or an accepted retry not yet seen to finish), so
 * results move from pending to success/failed without a manual reload.
 * Background polls never flip `loading`, so the UI never blanks into skeletons
 * mid-poll; only the initial load and an explicit `reload()` do that.
 *
 * Whole-branch review, Finding 1 — background polls must never touch `error`:
 * only the initial load and an explicit `reload()` (both foreground) own that
 * state, so a single dropped poll keeps the last-good list on screen instead
 * of replacing it with the full-width error state. That in turn means a
 * failed background poll never calls `setJobs` either, so `jobs` keeps its
 * identity — `pollCycle` below exists so the poll effect still has a fresh
 * dependency to re-arm on after every completed background attempt, success
 * or failure.
 */
export function usePostJobs(): UsePostJobsResult {
  const [jobs, setJobs] = useState<PostJobDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceMemberCount, setWorkspaceMemberCount] = useState<number | null>(null);
  // Bumped in the `finally` of every *background* load (see the poll effect
  // below). A failed background poll intentionally never calls `setJobs`, so
  // without this counter the poll effect would have no changed dependency to
  // re-run on after a failure and would stop re-arming for good.
  const [pollCycle, setPollCycle] = useState(0);
  // Activity pagination (Task C2). `nextCursor` is the opaque `?cursor=` token
  // for the next OLDER page from the last successful load (null = last page,
  // drives `hasMore`). Only a foreground load (initial/reload) and `loadMore`
  // move it; the background poll deliberately leaves it untouched so the loaded
  // tail's cursor survives a refresh. `loadingMore` guards + spins the button.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Job ids whose retry request was accepted and whose outcome we haven't seen
  // yet (2026-11-01 audit). Keeps the poll armed when the list itself shows
  // nothing in flight — see `shouldPollPostJobs`.
  const [retryWatch, setRetryWatch] = useState<ReadonlySet<string>>(new Set());
  // Bumped by `watchRetry`. A background fetch that STARTED before a retry was
  // accepted may read the job as still `failed`; if it resolves after that
  // retry it must not overwrite the fresher view or settle the watch.
  const retryEpochRef = useRef(0);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    const epoch = retryEpochRef.current;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetch("/api/posts");
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Please sign in to view your posts."
            : "Failed to load posts.",
        );
      }
      const data: PostsResponse = await response.json();
      if (background && epoch !== retryEpochRef.current) {
        // Stale relative to a retry accepted while this request was in flight;
        // the refetch `watchRetry` started will deliver the current view.
        return;
      }
      if (background) {
        // Background poll: keep page 1 fresh WITHOUT dropping the older tail the
        // user pulled in via Load more. `mergePolledPageOne` collapses to a plain
        // page-1 replace when no tail exists, so page-1 refresh is unchanged for
        // callers who never paginated. nextCursor is intentionally NOT touched
        // here — re-adopting page 1's cursor would make the next Load more
        // re-fetch already-shown rows (deep-tail staleness is accepted, §C).
        setJobs((prev) => (prev ? mergePolledPageOne(data.jobs, prev) : data.jobs));
      } else {
        // Foreground load (initial or explicit reload): reset to page 1 and adopt
        // its fresh cursor — a reload deliberately restarts pagination.
        setJobs(data.jobs);
        setNextCursor(data.nextCursor);
      }
      setWorkspaceMemberCount(data.workspaceMemberCount);
      setRetryWatch((prev) => settleRetryWatch(prev, data.jobs));
    } catch (err: unknown) {
      // Background failures keep the stale list on screen silently — only a
      // foreground (initial or manual-reload) failure surfaces the error UI.
      if (!background) {
        setError(err instanceof Error ? err.message : "Failed to load posts.");
      }
    } finally {
      if (background) {
        setPollCycle((cycle) => cycle + 1);
      } else {
        setLoading(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    // Guard: nothing older to fetch, or a page is already in flight. Reading
    // both from the closure is safe — the deps below refresh this callback on
    // every change, and the Button is `disabled` while `loadingMore` is true.
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/posts?cursor=${encodeURIComponent(nextCursor)}`);
      if (!response.ok) {
        // Silent: the full-width error state is owned by the initial load /
        // reload only (Finding 1). Leave the list AND nextCursor intact so the
        // button stays for a retry; the spinner stops in `finally`.
        return;
      }
      const data: PostsResponse = await response.json();
      // APPEND the older page, de-duped by id — a poll may have prepended a row
      // this page also carries; appendJobsPage keeps the on-screen copy so the
      // rendered list never has a duplicate key.
      setJobs((prev) => (prev ? appendJobsPage(prev, data.jobs) : data.jobs));
      setNextCursor(data.nextCursor);
    } catch {
      // Same as a non-ok response — keep the loaded list + cursor for a retry.
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const watchRetry = useCallback(
    (jobId: string) => {
      retryEpochRef.current += 1;
      setRetryWatch((prev) => new Set(prev).add(jobId));
      void load({ background: true });
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    load();
  }, [load]);

  // Background poll: only while something is still in flight (or an accepted
  // retry is still being watched), so an idle activity list never keeps a timer
  // running. Re-armed whenever `jobs` changes (any successful load), `pollCycle`
  // ticks (any completed background attempt, including a failed one that left
  // `jobs` untouched) OR `retryWatch` changes — so polling keeps going until
  // the server reports everything settled, and survives a dropped request
  // instead of stalling forever. Cleans up on unmount/re-run.
  useEffect(() => {
    if (!shouldPollPostJobs(jobs, retryWatch)) return;
    const t = setTimeout(() => {
      void load({ background: true });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [jobs, load, pollCycle, retryWatch]);

  return {
    jobs,
    loading,
    error,
    reload: load,
    workspaceMemberCount,
    loadMore,
    loadingMore,
    hasMore: nextCursor !== null,
    watchRetry,
  };
}
