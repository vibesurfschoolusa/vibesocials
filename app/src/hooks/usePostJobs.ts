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
 */
function hasWorkInFlight(jobs: PostJobDTO[] | null): boolean {
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
 */
export function usePostJobs(): UsePostJobsResult {
  const [jobs, setJobs] = useState<PostJobDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options?: { background?: boolean }) => {
    if (!options?.background) {
      setLoading(true);
    }
    setError(null);
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
      setError(err instanceof Error ? err.message : "Failed to load posts.");
    } finally {
      if (!options?.background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Background poll: only while something is still in flight, so an idle
  // activity list never keeps a timer running. Re-armed on every `jobs`
  // update (including the poll's own reload), so it keeps going until the
  // server reports everything settled — and cleans up on unmount/re-run.
  useEffect(() => {
    if (!hasWorkInFlight(jobs)) return;
    const t = setTimeout(() => {
      void load({ background: true });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [jobs, load]);

  return { jobs, loading, error, reload: load };
}
