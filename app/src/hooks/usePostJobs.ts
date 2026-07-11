"use client";

import { useCallback, useEffect, useState } from "react";

import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";

export interface UsePostJobsResult {
  jobs: PostJobDTO[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * True while any job has work in flight — a fresh publish still running, or a
 * retried result the server has marked pending. Drives the background poll
 * below so the activity/dashboard views catch up without a manual refresh.
 *
 * Exported (whole-branch review, Finding 1) so it can be unit-tested on its
 * own — the hook body itself has no React-render test harness in this repo.
 */
export function hasWorkInFlight(jobs: PostJobDTO[] | null): boolean {
  return (
    jobs?.some(
      (job) =>
        job.status === "in_progress" ||
        job.results.some((result) => result.status === "pending"),
    ) ?? false
  );
}

/**
 * Fetches the current user's post jobs from `GET /api/posts`. Shared by the
 * dashboard's recent-activity preview and the full activity view.
 *
 * Task 8 — polls every 10s while `hasWorkInFlight` is true (a fresh publish or
 * a retry still running), so results move from pending to success/failed
 * without a manual reload. Background polls never flip `loading`, so the UI
 * never blanks into skeletons mid-poll; only the initial load and an explicit
 * `reload()` do that.
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
  // Bumped in the `finally` of every *background* load (see the poll effect
  // below). A failed background poll intentionally never calls `setJobs`, so
  // without this counter the poll effect would have no changed dependency to
  // re-run on after a failure and would stop re-arming for good.
  const [pollCycle, setPollCycle] = useState(0);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
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
      setJobs(data.jobs);
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

  useEffect(() => {
    load();
  }, [load]);

  // Background poll: only while something is still in flight, so an idle
  // activity list never keeps a timer running. Re-armed whenever `jobs`
  // changes (any successful load) OR `pollCycle` ticks (any completed
  // background attempt, including a failed one that left `jobs` untouched) —
  // so polling keeps going until the server reports everything settled, and
  // survives a dropped request instead of stalling forever. Cleans up on
  // unmount/re-run.
  useEffect(() => {
    if (!hasWorkInFlight(jobs)) return;
    const t = setTimeout(() => {
      void load({ background: true });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [jobs, load, pollCycle]);

  return { jobs, loading, error, reload: load };
}
