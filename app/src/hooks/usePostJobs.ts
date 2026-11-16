"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceRole } from "@prisma/client";

import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import {
  decidePollAction,
  hasNewInFlightJob,
  inFlightJobIds,
  nextPollDelayMs,
  settleRetryWatch,
  shouldPollPostJobs,
} from "@/lib/postJobPolling";
import { appendJobsPage, mergePolledPageOne } from "@/lib/postsPagination";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";

/** R26 LL3: a Load more that got no answer. */
export const LOAD_MORE_OFFLINE_TEXT =
  "Couldn't load more posts: there's no connection. Check your connection, then press Load more again.";
/** R26 LL3: a Load more the server refused or answered with something unreadable. */
export const LOAD_MORE_FAILED_TEXT = "Couldn't load more posts. Press Load more to try again.";

/**
 * What the line under Load more says (Activity and the Queue): no answer, the
 * answer's status, or 0 for an answer that couldn't be read.
 */
export function loadMoreFailureText(failure: "offline" | number): string {
  if (failure === "offline") return LOAD_MORE_OFFLINE_TEXT;
  return failure === 401 ? SIGNED_OUT_ERROR : LOAD_MORE_FAILED_TEXT;
}

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
   * R10-client-journey L1: the viewer's role in the workspace, straight from
   * `PostsResponse.workspaceRole` (`null` until the first load). Only an owner
   * can reconnect, so `PostJobCard` words a member's steps for the owner.
   */
  workspaceRole: WorkspaceRole | null;
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
   * R26 LL3: why the last `loadMore()` failed (loadMoreFailureText), shown
   * under the button; null before a press, while one runs and after a success.
   */
  loadMoreError: string | null;
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
  /**
   * 2026-11-01 scale audit (W5) — true once the backoff schedule
   * (`nextPollDelayMs`) has run out while a job is still in flight: polling has
   * given up and the feed should say so (`POLLING_STOPPED_HINT`). Resets when a
   * job newly enters the in-flight set, and is false whenever nothing is in
   * flight.
   */
  pollingStopped: boolean;
}

/** N3: the filters `GET /api/posts?show=` accepts. */
export interface UsePostJobsOptions {
  /** "problems": only posts that did not fully go out (Activity's "Had a problem" tab). */
  show?: "problems";
}

/** The list URL for a filter and an optional Load more cursor. */
export function postJobsUrl(show: UsePostJobsOptions["show"], cursor?: string): string {
  const params = new URLSearchParams();
  if (show) params.set("show", show);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/api/posts?${query}` : "/api/posts";
}

/** True while the tab is in the background (minimized or another tab is shown). */
function isTabHidden(): boolean {
  return document.visibilityState === "hidden";
}

/**
 * Fetches the current user's post jobs from `GET /api/posts`. Shared by the
 * dashboard's recent-activity preview and the full activity view.
 *
 * Task 8 — polls while `shouldPollPostJobs` is true (a fresh publish or a
 * retry still running, or an accepted retry not yet seen to finish), so
 * results move from pending to success/failed without a manual reload.
 * Background polls never flip `loading`, so the UI never blanks into skeletons
 * mid-poll; only the initial load and an explicit `reload()` do that.
 *
 * 2026-11-01 scale audit (W5) — the cadence backs off (`nextPollDelayMs`: 10 s,
 * then 30 s, then 60 s, then stop after 30 minutes) instead of a flat 10 s
 * forever. The schedule's clock starts when polling starts and restarts when a
 * job newly enters the in-flight set (`hasNewInFlightJob`). A hidden tab never
 * fetches (`decidePollAction`); when it becomes visible again the feed fetches
 * at once and the schedule carries on from where its clock stands.
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
export function usePostJobs(options?: UsePostJobsOptions): UsePostJobsResult {
  // A primitive, so callers can pass a fresh `{ show }` object every render.
  const show = options?.show;
  // The filter the list on screen belongs to. A response for another filter
  // (one that started before the switch) is dropped, so no rows or cursor
  // from the other tab ever land.
  const showRef = useRef(show);
  const [jobs, setJobs] = useState<PostJobDTO[] | null>(null);
  // The filter `jobs` (and `nextCursor`) were loaded for, set together with
  // them. While it differs from `show` (a tab was just switched) the hook
  // reports no rows and loading, so another tab's rows can never show under
  // the new tab, not even for one render.
  const [jobsShow, setJobsShow] = useState(show);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceMemberCount, setWorkspaceMemberCount] = useState<number | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole | null>(null);
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
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Job ids whose retry request was accepted and whose outcome we haven't seen
  // yet (2026-11-01 audit). Keeps the poll armed when the list itself shows
  // nothing in flight — see `shouldPollPostJobs`.
  const [retryWatch, setRetryWatch] = useState<ReadonlySet<string>>(new Set());
  // Bumped by `watchRetry`. A background fetch that STARTED before a retry was
  // accepted may read the job as still `failed`; if it resolves after that
  // retry it must not overwrite the fresher view or settle the watch.
  const retryEpochRef = useRef(0);
  // 2026-11-01 scale audit (W5): when the current run of polling started
  // (Date.now()), and the in-flight job ids last seen — the baseline a "newly
  // in flight" comparison needs. `stopped` is set when the schedule runs out.
  const scheduleStartRef = useRef<number | null>(null);
  const inFlightIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [stopped, setStopped] = useState(false);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    const epoch = retryEpochRef.current;
    if (!background) {
      setLoading(true);
      setError(null);
      setLoadMoreError(null);
    }
    try {
      const response = await fetch(postJobsUrl(show));
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? SIGNED_OUT_ERROR
            : "Failed to load posts.",
        );
      }
      const data: PostsResponse = await response.json();
      if (show !== showRef.current) return;
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
        setJobsShow(show);
      }
      setWorkspaceMemberCount(data.workspaceMemberCount);
      setWorkspaceRole(data.workspaceRole ?? null);
      setRetryWatch((prev) => settleRetryWatch(prev, data.jobs));
    } catch (err: unknown) {
      // Background failures keep the stale list on screen silently — only a
      // foreground (initial or manual-reload) failure surfaces the error UI.
      if (!background && show === showRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load posts.");
      }
    } finally {
      if (background) {
        setPollCycle((cycle) => cycle + 1);
      } else if (show === showRef.current) {
        setLoading(false);
        // A failed load also settles the tab, so its error (and Retry) shows
        // instead of a skeleton that never ends.
        setJobsShow(show);
      }
    }
  }, [show]);

  const loadMore = useCallback(async () => {
    // Guard: nothing older to fetch, or a page is already in flight. Reading
    // both from the closure is safe — the deps below refresh this callback on
    // every change, and the Button is `disabled` while `loadingMore` is true.
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetchOrNoAnswer(postJobsUrl(show, nextCursor));
      if (!response.ok) {
        // The full-width error state is owned by the initial load / reload
        // only (Finding 1); R26 LL3: a line under the button says why. The list
        // AND nextCursor stay, so the next press retries the same page.
        if (show === showRef.current) setLoadMoreError(loadMoreFailureText(response.status));
        return;
      }
      const data: PostsResponse = await response.json();
      if (show !== showRef.current) return;
      // APPEND the older page, de-duped by id — a poll may have prepended a row
      // this page also carries; appendJobsPage keeps the on-screen copy so the
      // rendered list never has a duplicate key.
      setJobs((prev) => (prev ? appendJobsPage(prev, data.jobs) : data.jobs));
      setNextCursor(data.nextCursor);
    } catch (error) {
      // Same as a non-ok response — keep the loaded list + cursor for a retry.
      if (show === showRef.current) setLoadMoreError(loadMoreFailureText(isNoAnswer(error) ? "offline" : 0));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, show]);

  const watchRetry = useCallback(
    (jobId: string) => {
      retryEpochRef.current += 1;
      setRetryWatch((prev) => new Set(prev).add(jobId));
      void load({ background: true });
    },
    [load],
  );

  // Runs on mount and again whenever the filter changes (`load` follows
  // `show`): the list restarts from page 1 of the new filter.
  useEffect(() => {
    if (showRef.current !== show) {
      showRef.current = show;
      setJobs(null);
      setNextCursor(null);
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    load();
  }, [load, show]);

  // 2026-11-01 scale audit (W5): restart the backoff schedule whenever a job
  // newly enters the in-flight set (a new publish, a retry, a watch added by
  // `watchRetry`) — the user just did something, so poll quickly again. Declared
  // before the poll effect: effects of one commit run in order, so the poll
  // effect below always sees the fresh start time.
  useEffect(() => {
    const ids = inFlightJobIds(jobs, retryWatch);
    if (hasNewInFlightJob(inFlightIdsRef.current, ids)) {
      scheduleStartRef.current = Date.now();
      setStopped(false);
    }
    inFlightIdsRef.current = ids;
  }, [jobs, retryWatch]);

  // Background poll: only while something is still in flight (or an accepted
  // retry is still being watched), so an idle activity list never keeps a timer
  // running. Re-armed whenever `jobs` changes (any successful load), `pollCycle`
  // ticks (any completed background attempt, including a failed one that left
  // `jobs` untouched) OR `retryWatch` changes — so polling keeps going until
  // the server reports everything settled, and survives a dropped request
  // instead of stalling forever. Cleans up on unmount/re-run.
  //
  // 2026-11-01 scale audit (W5): the delay comes from `nextPollDelayMs` and the
  // tick asks `decidePollAction` what to do. "fetch" runs a background load
  // (whose completion bumps `pollCycle` and so re-arms); "stop" flips `stopped`
  // and nothing re-arms; "skip" (tab hidden) does nothing, deliberately leaving
  // no timer behind — the visibilitychange listener below resumes on return, so
  // a hidden tab costs no wake-ups at all. Elapsed time keeps counting meanwhile
  // because it is measured from `scheduleStartRef`, not from timer to timer. A
  // schedule that has already run out arms a 0 ms tick so the stop is decided in
  // one place (and a hidden tab still never advances to stopped).
  useEffect(() => {
    if (stopped || !shouldPollPostJobs(jobs, retryWatch)) return;
    const start = scheduleStartRef.current ?? Date.now();
    const t = setTimeout(() => {
      const action = decidePollAction("timer", Date.now() - start, isTabHidden());
      if (action === "fetch") void load({ background: true });
      else if (action === "stop") setStopped(true);
    }, nextPollDelayMs(Date.now() - start) ?? 0);
    return () => clearTimeout(t);
  }, [jobs, load, pollCycle, retryWatch, stopped]);

  // 2026-11-01 scale audit (W5): back in the foreground — fetch at once rather
  // than wait out the next tick, so a user returning to the tab after their
  // jobs finished sees the fresh state immediately. Only when something is in
  // flight. That includes after polling has stopped: the return then costs a
  // one-shot fetch, deliberately NOT clearing `stopped` or re-arming (the poll
  // effect above returns early while stopped), so a job that settled while the
  // user was away clears the hint on its own and one still running keeps it. The
  // listener is registered once and reads the latest state through a ref, so it
  // is added a single time and removed on unmount.
  const onVisibilityChangeRef = useRef<() => void>(() => {});
  useEffect(() => {
    onVisibilityChangeRef.current = () => {
      if (!shouldPollPostJobs(jobs, retryWatch)) return;
      const start = scheduleStartRef.current ?? Date.now();
      if (decidePollAction("visibility", Date.now() - start, isTabHidden()) === "fetch") {
        void load({ background: true });
      }
    };
  });
  useEffect(() => {
    const listener = () => onVisibilityChangeRef.current();
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);

  const rowsMatchFilter = jobsShow === show;

  return {
    jobs: rowsMatchFilter ? jobs : null,
    loading: loading || !rowsMatchFilter,
    error,
    reload: load,
    workspaceMemberCount,
    workspaceRole,
    loadMore,
    loadingMore,
    loadMoreError,
    hasMore: rowsMatchFilter && nextCursor !== null,
    watchRetry,
    // Derived: a stale `stopped` (set in an earlier run, jobs since settled)
    // must not show the hint.
    pollingStopped: stopped && shouldPollPostJobs(jobs, retryWatch),
  };
}
